/**
 * The cancellation link against a REAL Firestore (issue #252 step 5, PR F2).
 *
 * The unit tests in `__tests__/company/cancelCompanyDeletionByToken.test.ts`
 * cover the state machine with a stubbed transaction. What they cannot cover
 * is the property the whole design leans on: that spending the token and
 * cancelling the deletion are ONE atomic operation, so two people clicking
 * the same link at the same second produce exactly one cancellation. A
 * stubbed `runTransaction` that just invokes its callback is, by
 * construction, incapable of failing that test.
 *
 * Also covers `blockMemberWrite` (functions/src/company/acceptsMembers.ts)
 * against real documents — the shared guard behind both invitation-acceptance
 * paths, which cannot be reached through its Cloud Functions wrappers from a
 * test.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase-admin'
import { cancelCompanyDeletionByToken } from '@/actions/companyDeletion'
import { lookupCancelToken } from '@/lib/queries/companyDeletionCancel'
import { blockMemberWrite } from '../../functions/src/company/acceptsMembers'

const COMPANY_ID = 'cancel-co'
const REQUEST_ID = 'cancel-req'
const TOKEN = 'cancel-token-abcdef'
const HOUR = 60 * 60 * 1000

async function seedPendingDeletion(opts: { expiresInMs?: number } = {}) {
  const now = Timestamp.now()
  const scheduledFor = Timestamp.fromMillis(now.toMillis() + 7 * 24 * HOUR)
  const expiresAt = Timestamp.fromMillis(now.toMillis() + (opts.expiresInMs ?? 7 * 24 * HOUR))

  await adminDb.doc(`companies/${COMPANY_ID}`).set({
    name: 'Rigg & Rep AB',
    createdAt: now,
    // No stripeCustomerId / subscription: the resume helper short-circuits to
    // `no_subscription` without ever constructing a Stripe client, so these
    // tests need no Stripe key and make no network calls.
    deletion: {
      state: 'requested',
      requestId: REQUEST_ID,
      requestedAt: now,
      requestedByName: 'Anna Admin',
      scheduledFor,
      mode: 'window',
    },
  })

  await adminDb.doc(`companies/${COMPANY_ID}/members/admin-1`).set({
    uid: 'admin-1',
    name: 'Anna Admin',
    email: 'anna@example.com',
    role: 'admin',
  })

  await adminDb.doc(`companyDeletions/${REQUEST_ID}`).set({
    requestId: REQUEST_ID,
    companyId: COMPANY_ID,
    companyName: 'Rigg & Rep AB',
    mode: 'window',
    state: 'requested',
    requestedAt: now,
    requestedByUid: 'admin-1',
    requestedByName: 'Anna Admin',
    requestedByEmail: 'anna@example.com',
    scheduledFor,
    attempts: 0,
    cancelTokenIds: [TOKEN],
    purgeAfter: Timestamp.fromMillis(now.toMillis() + 730 * 24 * HOUR),
  })

  await adminDb.doc(`companyDeletionCancelTokens/${TOKEN}`).set({
    requestId: REQUEST_ID,
    companyId: COMPANY_ID,
    createdAt: now,
    expiresAt,
  })
}

async function mailCount(): Promise<number> {
  const snap = await adminDb.collection('mail').get()
  return snap.size
}

describe('cancelCompanyDeletionByToken — against the emulator', () => {
  beforeEach(async () => {
    await seedPendingDeletion()
  })

  it('cancels the deletion, spends the token and queues one mail per admin', async () => {
    const result = await cancelCompanyDeletionByToken(TOKEN)
    expect(result.state).toBe('valid')

    const company = (await adminDb.doc(`companies/${COMPANY_ID}`).get()).data()!
    // The FIELD is gone, not set to some cancelled value — absence is the
    // only "nothing is going on" signal the sweep and the banner read.
    expect(company['deletion']).toBeUndefined()

    const ledger = (await adminDb.doc(`companyDeletions/${REQUEST_ID}`).get()).data()!
    expect(ledger['state']).toBe('canceled')
    expect(ledger['cancelSource']).toBe('cancel_link')
    expect(ledger['canceledAt']).toBeDefined()

    const token = (await adminDb.doc(`companyDeletionCancelTokens/${TOKEN}`).get()).data()!
    expect(token['usedAt']).toBeDefined()

    expect(await mailCount()).toBe(1)
  })

  it('MUTATION GUARD: a second click cancels nothing again and sends no second mail', async () => {
    await cancelCompanyDeletionByToken(TOKEN)
    const after = await cancelCompanyDeletionByToken(TOKEN)

    // Reported as already-cancelled rather than as a spent link: what the
    // visitor asked about is the company, and the company is safe.
    expect(after.state).toBe('already_canceled')
    expect(await mailCount()).toBe(1)
  })

  it('MUTATION GUARD: two simultaneous clicks produce exactly ONE cancellation', async () => {
    // The property a stubbed transaction cannot test. Both calls read the
    // same unspent token; Firestore serialises the conflicting writes, so one
    // commits and the other re-reads a token that is now spent (or a ledger
    // that is now cancelled).
    const [a, b] = await Promise.all([
      cancelCompanyDeletionByToken(TOKEN),
      cancelCompanyDeletionByToken(TOKEN),
    ])

    const states = [a.state, b.state].sort()
    expect(states).toContain('valid')
    expect(states.filter((s) => s === 'valid')).toHaveLength(1)

    // One winner means one cancellation mail — the sharpest observable
    // consequence of a double-cancel would be two of them.
    expect(await mailCount()).toBe(1)
  })

  it('MUTATION GUARD: an expired token leaves the deletion completely untouched', async () => {
    await adminDb
      .doc(`companyDeletionCancelTokens/${TOKEN}`)
      .update({ expiresAt: Timestamp.fromMillis(Date.now() - HOUR) })

    const result = await cancelCompanyDeletionByToken(TOKEN)

    expect(result.state).toBe('expired')
    const company = (await adminDb.doc(`companies/${COMPANY_ID}`).get()).data()!
    expect(company['deletion']).toBeDefined()
    expect((await adminDb.doc(`companyDeletions/${REQUEST_ID}`).get()).data()!['state']).toBe('requested')
    expect(await mailCount()).toBe(0)
  })

  it('MUTATION GUARD: merely looking at the link (a GET) changes nothing', async () => {
    // Mail scanners and link prefetchers fetch these URLs unprompted. This is
    // what makes it safe to put the link in an email at all.
    const lookup = await lookupCancelToken(TOKEN)
    expect(lookup.state).toBe('valid')

    const company = (await adminDb.doc(`companies/${COMPANY_ID}`).get()).data()!
    expect(company['deletion']).toBeDefined()
    const token = (await adminDb.doc(`companyDeletionCancelTokens/${TOKEN}`).get()).data()!
    expect(token['usedAt']).toBeUndefined()
    expect(await mailCount()).toBe(0)
  })

  it('an unknown token touches nothing', async () => {
    expect((await cancelCompanyDeletionByToken('not-a-real-token')).state).toBe('unknown')
    expect((await adminDb.doc(`companies/${COMPANY_ID}`).get()).data()!['deletion']).toBeDefined()
  })
})

describe('blockMemberWrite — the shared invitation guard', () => {
  it('MUTATION GUARD: refuses a company with a deletion scheduled', async () => {
    await seedPendingDeletion()
    const snap = await adminDb.doc(`companies/${COMPANY_ID}`).get()
    expect(blockMemberWrite(snap)?.code).toBe('deleting')
  })

  it('refuses a company that is being purged right now, not just one that is merely scheduled', async () => {
    // Presence of the field is the check, deliberately: a `state ===
    // 'requested'` comparison would let someone join mid-purge, which is the
    // one moment it is most wrong.
    await seedPendingDeletion()
    await adminDb.doc(`companies/${COMPANY_ID}`).update({ 'deletion.state': 'executing' })
    const snap = await adminDb.doc(`companies/${COMPANY_ID}`).get()
    expect(blockMemberWrite(snap)?.code).toBe('deleting')
  })

  it('refuses a company that no longer exists', async () => {
    const snap = await adminDb.doc('companies/never-existed').get()
    expect(blockMemberWrite(snap)?.code).toBe('not-found')
  })

  it('allows an ordinary company, and allows it again once a deletion is cancelled', async () => {
    await seedPendingDeletion()
    await cancelCompanyDeletionByToken(TOKEN)

    const snap = await adminDb.doc(`companies/${COMPANY_ID}`).get()
    // Self-releasing: nothing has to remember to re-open invitations.
    expect(blockMemberWrite(snap)).toBeNull()
  })
})
