/**
 * Issue #252 step 6 — the enforcement sweep
 * (functions/src/company/strandedAccountSweep.ts) that acts on a
 * `pendingDeletion` schedule written by `cleanupOneMember`
 * (memberCleanup.ts). See that file's own module docblock: this is the most
 * destructive code in the repository, and every test here is designed to
 * confirm the bias is toward NOT deleting.
 */
import { describe, expect, it, vi } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import { adminAuth, adminDb } from '@/lib/firebase-admin'
import { runStrandedAccountSweep } from '../../functions/src/company/strandedAccountSweep'
import { getTestFunctionsDb } from '../../functions/src/testSupport/emulatorInit'
import {
  TRIGGERED_BY_STRANDED_ACCOUNT_ENFORCED,
  TRIGGERED_BY_STRANDED_ACCOUNT_SPARED,
  TRIGGERED_BY_STRANDED_MEMBER_SCHEDULED,
} from '../../functions/src/deletionAuditLogTriggers'

const PAST = () => Timestamp.fromMillis(Date.now() - 60_000)
const FUTURE = () => Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000)

async function seedStrandedUser(
  uid: string,
  opts: { scheduledFor: Timestamp; requestId?: string; email?: string },
): Promise<void> {
  await adminAuth.createUser({ uid, email: opts.email ?? `${uid}@example.com` })
  await adminDb.doc(`users/${uid}`).set({
    name: `User ${uid}`,
    email: opts.email ?? `${uid}@example.com`,
    activeCompanyId: null,
    pendingDeletion: { scheduledFor: opts.scheduledFor, requestId: opts.requestId ?? `${uid}-req` },
  })
}

describe('strandedAccountSweep', () => {
  it('due + zero memberships: deletes the user doc, deletes the Auth record, writes an audit row', async () => {
    const uid = 'due-no-memberships'
    await seedStrandedUser(uid, { scheduledFor: PAST(), requestId: 'req-1' })

    const db = getTestFunctionsDb()
    const result = await runStrandedAccountSweep(db)

    expect(result).toEqual({ deleted: 1, deletedAuthFailed: 0, spared: 0, skipped: 0, failed: 0 })

    const userSnap = await adminDb.doc(`users/${uid}`).get()
    expect(userSnap.exists).toBe(false)

    await expect(adminAuth.getUser(uid)).rejects.toThrow()

    const auditSnap = await adminDb
      .collection('deletionAuditLog')
      .where('requestId', '==', 'req-1')
      .get()
    expect(auditSnap.size).toBe(1)
    const row = auditSnap.docs[0].data()
    expect(row.triggeredBy).toBe(TRIGGERED_BY_STRANDED_ACCOUNT_ENFORCED)
    expect(row.triggeredBy).not.toBe('user_self')
    expect(row.triggeredBy).not.toBe(TRIGGERED_BY_STRANDED_MEMBER_SCHEDULED)
    expect(row.deletedAt).toBeTruthy()
    // No PII — only a hash.
    expect(row.userIdHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('due + a membership exists: the account is SPARED and pendingDeletion is cleared, nothing is deleted', async () => {
    const uid = 'due-with-membership'
    await seedStrandedUser(uid, { scheduledFor: PAST(), requestId: 'req-2' })
    // A membership that cancelled her strandedness without clearing the
    // field — the exact gap Part A of this change closes for
    // acceptInvitation, and what any future route back to a company would
    // also need to guard against.
    await adminDb.doc(`users/${uid}/memberships/some-company`).set({
      companyId: 'some-company',
      role: 'crew',
      joinedAt: Timestamp.now(),
    })

    const db = getTestFunctionsDb()
    const result = await runStrandedAccountSweep(db)

    expect(result).toEqual({ deleted: 0, deletedAuthFailed: 0, spared: 1, skipped: 0, failed: 0 })

    const userSnap = await adminDb.doc(`users/${uid}`).get()
    expect(userSnap.exists).toBe(true)
    expect(userSnap.data()?.pendingDeletion).toBeUndefined()

    // Still a real Auth user.
    const authUser = await adminAuth.getUser(uid)
    expect(authUser).toBeTruthy()

    // The membership itself is untouched.
    const membershipSnap = await adminDb.doc(`users/${uid}/memberships/some-company`).get()
    expect(membershipSnap.exists).toBe(true)

    const auditSnap = await adminDb
      .collection('deletionAuditLog')
      .where('requestId', '==', 'req-2')
      .get()
    expect(auditSnap.size).toBe(1)
    expect(auditSnap.docs[0].data().triggeredBy).toBe(TRIGGERED_BY_STRANDED_ACCOUNT_SPARED)
  })

  it('scheduledFor in the future: completely untouched', async () => {
    const uid = 'not-due-yet'
    await seedStrandedUser(uid, { scheduledFor: FUTURE(), requestId: 'req-3' })

    const db = getTestFunctionsDb()
    // Query itself won't even return this uid (scheduledFor > now), so this
    // exercises the query boundary, not just the in-code re-check.
    const result = await runStrandedAccountSweep(db)

    expect(result).toEqual({ deleted: 0, deletedAuthFailed: 0, spared: 0, skipped: 0, failed: 0 })

    const userSnap = await adminDb.doc(`users/${uid}`).get()
    expect(userSnap.exists).toBe(true)
    expect(userSnap.data()?.pendingDeletion).toBeTruthy()

    const authUser = await adminAuth.getUser(uid)
    expect(authUser).toBeTruthy()
  })

  it('no pendingDeletion field at all: untouched', async () => {
    const uid = 'never-scheduled'
    await adminAuth.createUser({ uid, email: `${uid}@example.com` })
    await adminDb.doc(`users/${uid}`).set({ name: 'Regular User', email: `${uid}@example.com`, activeCompanyId: 'some-co' })

    const db = getTestFunctionsDb()
    const result = await runStrandedAccountSweep(db)

    expect(result).toEqual({ deleted: 0, deletedAuthFailed: 0, spared: 0, skipped: 0, failed: 0 })

    const userSnap = await adminDb.doc(`users/${uid}`).get()
    expect(userSnap.exists).toBe(true)
    const authUser = await adminAuth.getUser(uid)
    expect(authUser).toBeTruthy()
  })

  it('running the sweep twice is a no-op the second time', async () => {
    const deletedUid = 'twice-deleted'
    const sparedUid = 'twice-spared'
    await seedStrandedUser(deletedUid, { scheduledFor: PAST(), requestId: 'req-4' })
    await seedStrandedUser(sparedUid, { scheduledFor: PAST(), requestId: 'req-5' })
    await adminDb.doc(`users/${sparedUid}/memberships/some-company`).set({
      companyId: 'some-company',
      role: 'crew',
      joinedAt: Timestamp.now(),
    })

    const db = getTestFunctionsDb()
    const first = await runStrandedAccountSweep(db)
    expect(first).toEqual({ deleted: 1, deletedAuthFailed: 0, spared: 1, skipped: 0, failed: 0 })

    const second = await runStrandedAccountSweep(db)
    // Nothing left that the query can even return: the deleted uid's doc is
    // gone, and the spared uid no longer carries pendingDeletion.
    expect(second).toEqual({ deleted: 0, deletedAuthFailed: 0, spared: 0, skipped: 0, failed: 0 })

    // No duplicate audit rows from the second pass.
    const auditSnap = await adminDb.collection('deletionAuditLog').get()
    expect(auditSnap.size).toBe(2)
  })

  it('one user failing does not prevent the others from being processed', async () => {
    const goodUid = 'good-candidate'
    const badUid = 'bad-candidate'
    await seedStrandedUser(goodUid, { scheduledFor: PAST(), requestId: 'req-good' })
    await seedStrandedUser(badUid, { scheduledFor: PAST(), requestId: 'req-bad' })

    const db = getTestFunctionsDb()
    // Force the live re-read inside `processCandidate` to throw for exactly
    // one candidate's `users/{uid}` doc, on its first call only — this is
    // the per-candidate try/catch in `runStrandedAccountSweep` doing its
    // job, not the Auth-delete-after-commit asymmetry (that one is already
    // covered by `deleteCandidate`'s own try/catch and logged there instead
    // of counted as `failed`).
    const originalDoc = db.doc.bind(db)
    const docSpy = vi.spyOn(db, 'doc').mockImplementation((path: string) => {
      const ref = originalDoc(path)
      if (path === `users/${badUid}`) {
        const originalGet = ref.get.bind(ref)
        let calls = 0
        ;(ref as unknown as { get: () => Promise<unknown> }).get = () => {
          calls += 1
          if (calls === 1) return Promise.reject(new Error('simulated read failure'))
          return originalGet()
        }
      }
      return ref
    })

    let result
    try {
      result = await runStrandedAccountSweep(db)
    } finally {
      docSpy.mockRestore()
    }

    expect(result.failed).toBe(1)
    expect(result.deleted).toBe(1)

    const goodUserSnap = await adminDb.doc(`users/${goodUid}`).get()
    expect(goodUserSnap.exists).toBe(false)
    await expect(adminAuth.getUser(goodUid)).rejects.toThrow()

    // The bad candidate was never touched — its read failed before any
    // decision was made about it.
    const badUserSnap = await adminDb.doc(`users/${badUid}`).get()
    expect(badUserSnap.exists).toBe(true)
  })
})
