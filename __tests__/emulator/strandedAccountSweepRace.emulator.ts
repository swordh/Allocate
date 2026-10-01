/**
 * Security review blocker: `processCandidate` used to decide delete-vs-spare
 * from one read (`hasAnyLiveMembership`), then hand off to `deleteCandidate`,
 * which re-read `users/{uid}/memberships` itself but ONLY to enumerate which
 * documents to delete — never to re-check whether the collection was still
 * empty. A membership created in the window between the first read and that
 * second read (the realistic case: `acceptInvitationByToken`,
 * functions/src/auth/acceptInvitation.ts, accepting an invite for this exact
 * uid while the sweep is mid-flight on her) would be READ by the second
 * query, deleted right along with it, and her account destroyed anyway —
 * the one read positioned to veto the irreversible act instead cleared the
 * evidence of why it should have.
 *
 * The fix (`processCandidateTransaction` in strandedAccountSweep.ts) makes
 * the read-memberships-and-decide step and the writes that follow from it
 * one Firestore transaction, so a concurrent membership write forces a
 * retry rather than being silently outrun.
 *
 * This test forces exactly that interleaving: it patches `db.runTransaction`
 * so that the FIRST time the sweep opens a transaction for this uid, a
 * membership document is written for her (simulating
 * `acceptInvitationByToken` completing concurrently) before the real
 * transaction body runs at all. Against the current, transactional
 * implementation this must retry and observe the new membership, sparing
 * her. Against the prior, non-transactional implementation this exact
 * interleaving deleted her account — this test was run against that version
 * before the fix and failed (see the task notes); it is checked in here
 * passing against the fixed version.
 */
import { describe, expect, it, vi } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import { adminAuth, adminDb } from '@/lib/firebase-admin'
import { runStrandedAccountSweep } from '../../functions/src/company/strandedAccountSweep'
import { getTestFunctionsDb } from '../../functions/src/testSupport/emulatorInit'

describe('strandedAccountSweep — concurrent invitation-acceptance race', () => {
  it('a membership created after the candidate is picked up, but before the deciding read, spares the account', async () => {
    const uid = 'race-invited-during-sweep'
    const companyId = 'race-target-co'

    await adminAuth.createUser({ uid, email: `${uid}@example.com` })
    await adminDb.doc(`users/${uid}`).set({
      name: 'Race Candidate',
      email: `${uid}@example.com`,
      activeCompanyId: null,
      pendingDeletion: {
        scheduledFor: Timestamp.fromMillis(Date.now() - 60_000),
        requestId: 'race-req',
      },
    })

    const db = getTestFunctionsDb()
    const originalRunTransaction = db.runTransaction.bind(db)
    let injected = false
    const txSpy = vi
      .spyOn(db, 'runTransaction')
      .mockImplementation(async (updateFunction: Parameters<typeof db.runTransaction>[0]) => {
        if (!injected) {
          injected = true
          // Simulate acceptInvitationByToken's own transaction landing in the
          // gap between this uid being picked up by the sweep and the
          // sweep's own authoritative read — BEFORE the real transaction
          // (whose reads must now observe this) ever runs.
          await adminDb.doc(`users/${uid}/memberships/${companyId}`).set({
            companyId,
            role: 'crew',
            joinedAt: Timestamp.now(),
          })
        }
        return originalRunTransaction(updateFunction)
      })

    try {
      const result = await runStrandedAccountSweep(db)
      expect(result.spared).toBe(1)
      expect(result.deleted).toBe(0)
    } finally {
      txSpy.mockRestore()
    }

    const userSnap = await adminDb.doc(`users/${uid}`).get()
    expect(userSnap.exists).toBe(true)
    expect(userSnap.data()?.pendingDeletion).toBeUndefined()

    const authUser = await adminAuth.getUser(uid)
    expect(authUser).toBeTruthy()

    const membershipSnap = await adminDb.doc(`users/${uid}/memberships/${companyId}`).get()
    expect(membershipSnap.exists).toBe(true)
  })
})
