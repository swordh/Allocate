/**
 * resendInvitation — dedicated resend action (commit 5, redesign phase 2).
 *
 * Extracted out of inviteUser's fallback so the team page's per-row RESEND
 * button doesn't have to re-post the whole invite form. Must read the token
 * from the private doc server-side (never accept one from the client), be
 * admin-guarded, and require status === 'pending'.
 *
 * Issue #297 follow-up (security review): the mirror-recreating write now
 * happens inside a `runTransaction`, not a plain `batch` — see
 * `extendPendingInvite`'s docblock in `actions/team.ts` for the
 * revoke/accept race this closes. The "recreates a fresh mirror" test below
 * asserts against `tx.update`/`tx.set`, and a dedicated regression test
 * proves the transaction's own re-read — not the pre-check read — is what's
 * authoritative.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {
    doc: vi.fn(),
    collection: vi.fn(),
    batch: vi.fn(),
    runTransaction: vi.fn(),
  },
  adminAuth: {},
}))

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { resendInvitation } from '@/actions/team'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { wireDb, makeTransaction, type DocMap } from '../helpers/firestore'

const COMPANY_ID = 'company-A'
const INVITE_ID = 'invite-1'
const TOKEN = 'existingtoken0123456789abcdef01'
const EMAIL = 'crew@example.com'
const INVITE_PATH = `companies/${COMPANY_ID}/invitations/${INVITE_ID}`

function stubSession(role: 'admin' | 'crew' = 'admin') {
  vi.mocked(getVerifiedSession).mockResolvedValue({
    uid: 'admin-1',
    email: 'admin@example.com',
    activeCompanyId: COMPANY_ID,
    role,
  })
}

function pendingInviteDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: INVITE_ID,
    email: EMAIL,
    role: 'crew',
    invitedBy: 'admin-1',
    invitedByName: 'Admin One',
    invitedAt: '2026-07-28T00:00:00.000Z',
    status: 'pending',
    token: TOKEN,
    expiresAt: '2026-08-04T00:00:00.000Z', // already expired — resend should still work
    ...overrides,
  }
}

/**
 * Wires the pre-check read (`adminDb.doc(...).get()`) AND the transaction's
 * own read to the SAME docs map — the ordinary, non-racy case. Also wires
 * `adminDb.collection('mail').add`, and returns the `tx` stub so a test can
 * assert `tx.update`/`tx.set` calls.
 */
function wire(inviteOverrides: Record<string, unknown> = {}) {
  const docs: DocMap = {
    [INVITE_PATH]: pendingInviteDoc(inviteOverrides),
    [`companies/${COMPANY_ID}`]: { name: 'Nordfilm AB' },
  }

  const wired = wireDb(adminDb as unknown as Record<string, unknown>, { docs })

  const innerCollection = wired.collection as unknown as (path: string) => Record<string, unknown>
  const collectionWithAdd = vi.fn((path: string) => {
    const chain = innerCollection(path)
    chain['add'] = vi.fn().mockResolvedValue({ id: 'mail-1' })
    return chain
  })
  ;(adminDb as unknown as Record<string, unknown>)['collection'] = collectionWithAdd

  const tx = makeTransaction(docs)
  vi.mocked(adminDb.runTransaction).mockImplementation(
    (cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx),
  )

  return { ...wired, tx }
}

describe('resendInvitation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T00:00:00.000Z'))
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.allocate.at'
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects a non-admin caller', async () => {
    stubSession('crew')
    wire()

    const result = await resendInvitation(INVITE_ID)

    expect(result.error).toBe('Unauthorized')
  })

  it('rejects an unknown invitation', async () => {
    stubSession()
    wireDb(adminDb as unknown as Record<string, unknown>, { docs: {} })

    const result = await resendInvitation('missing')

    expect(result.error).toBe('Invitation not found')
  })

  it('rejects a non-pending invitation (caught by the pre-check, before any transaction)', async () => {
    stubSession()
    wire({ status: 'accepted' })

    const result = await resendInvitation(INVITE_ID)

    expect(result.error).toMatch(/only pending/i)
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
  })

  it('extends expiresAt, stamps lastSentAt, recreates the mirror with expireAt, and re-queues the email', async () => {
    stubSession()
    const { tx } = wire()

    const result = await resendInvitation(INVITE_ID)

    expect(result.error).toBeUndefined()
    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: INVITE_PATH }),
      { expiresAt: '2026-08-12T00:00:00.000Z', lastSentAt: '2026-08-05T00:00:00.000Z' },
    )
    // Issue #297: the mirror is fully REPLACED with `tx.set`, not
    // `tx.update` — a resend must recreate a mirror the TTL policy already
    // deleted, and `expireAt` must match `expiresAt` exactly.
    expect(tx.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: `invitations/${TOKEN}` }),
      expect.anything(),
    )
    expect(tx.set).toHaveBeenCalledWith(
      expect.objectContaining({ path: `invitations/${TOKEN}` }),
      {
        companyId: COMPANY_ID,
        inviteId: INVITE_ID,
        email: EMAIL,
        status: 'pending',
        expiresAt: '2026-08-12T00:00:00.000Z',
        expireAt: Timestamp.fromDate(new Date('2026-08-12T00:00:00.000Z')),
      },
    )
  })

  it('never trusts a client-supplied token — always reads it from the private doc', async () => {
    // Regardless of what inviteId resolves to, the token used for the mirror
    // set must come from the transaction's own read of the invite doc, not
    // from any client input (resendInvitation's signature doesn't even
    // accept one).
    stubSession()
    const { tx } = wire()

    await resendInvitation(INVITE_ID)

    const mirrorSetCall = tx.set.mock.calls.find(
      (call: unknown[]) => (call[0] as { path: string }).path === `invitations/${TOKEN}`,
    )
    expect(mirrorSetCall).toBeDefined()
  })

  // ── Regression: revoke-vs-resend race (issue #297 follow-up) ───────────────
  it('REGRESSION: an invite revoked between the pre-check and the transaction is NOT resent — no mirror write, no mail, an error', async () => {
    stubSession()

    // The pre-check read (adminDb.doc(...).get(), via wireDb) sees the invite
    // as still 'pending' — this is the state resendInvitation observes first.
    const docs: DocMap = {
      [INVITE_PATH]: pendingInviteDoc(),
      [`companies/${COMPANY_ID}`]: { name: 'Nordfilm AB' },
    }
    const wired = wireDb(adminDb as unknown as Record<string, unknown>, { docs })

    const innerCollection = wired.collection as unknown as (path: string) => Record<string, unknown>
    const mailAdd = vi.fn().mockResolvedValue({ id: 'mail-1' })
    const collectionWithAdd = vi.fn((path: string) => {
      const chain = innerCollection(path)
      chain['add'] = mailAdd
      return chain
    })
    ;(adminDb as unknown as Record<string, unknown>)['collection'] = collectionWithAdd

    // But by the time the transaction actually runs, a concurrent
    // revokeInvitation has already committed — the SAME doc, read fresh
    // inside the transaction, now says 'revoked'. This is the race: a plain
    // `batch` (the pre-fix implementation) would never have seen this, since
    // it never re-read the doc at all.
    const racedDocs: DocMap = {
      [INVITE_PATH]: { ...pendingInviteDoc(), status: 'revoked', revokedAt: '2026-08-05T00:00:00.000Z' },
    }
    const tx = makeTransaction(racedDocs)
    vi.mocked(adminDb.runTransaction).mockImplementation(
      (cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx),
    )

    const result = await resendInvitation(INVITE_ID)

    expect(result.error).toMatch(/only pending/i)
    // The transaction's authoritative check caught the race: no write of any
    // kind was staged inside it.
    expect(tx.update).not.toHaveBeenCalled()
    expect(tx.set).not.toHaveBeenCalled()
    // Critically: no mail was queued for a mirror that was never recreated.
    expect(mailAdd).not.toHaveBeenCalled()
  })
})
