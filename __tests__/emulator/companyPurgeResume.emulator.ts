/**
 * "Återupptagning" — issue #252 step 5, PR E. A purge that dies mid-"subtree"
 * phase must resume from that phase on the next call, without redoing the
 * earlier phases (stripe/invitations/members), and the end result must be
 * identical to an uninterrupted run.
 *
 * Simulated by seeding a ledger whose `completedPhases` already includes
 * everything up to and including `members` (as if a prior attempt crashed
 * right after finishing that phase, before subtree started), then calling
 * `runCompanyPurge` once and checking it goes straight to subtree/orphans/
 * finalize.
 */
import { createHash } from 'crypto'
import { describe, expect, it, vi } from 'vitest'
import { adminDb } from '@/lib/firebase-admin'
import { runCompanyPurge } from '../../functions/src/company/purge'
import { getTestFunctionsDb } from '../../functions/src/testSupport/emulatorInit'
import { seedRequestedDeletion, seedMember } from './companyDeletionFixtures'

describe('runCompanyPurge — resume', () => {
  it('resumes from the subtree phase without redoing stripe/invitations/members', async () => {
    const companyId = 'resume-co'
    const requestId = 'resume-req'

    await seedRequestedDeletion(adminDb, {
      companyId,
      requestId,
      completedPhases: ['stripe', 'invitations', 'members'],
      phase: 'members',
    })
    await seedMember(adminDb, companyId, 'resume-member-1', { email: 'resumemember@example.com' })
    // formerMemberContacts as the already-completed members phase would have
    // left it — this is the resume marker runMembersPhase checks.
    await adminDb.doc(`companyDeletions/${requestId}`).update({
      formerMemberContacts: [
        { uid: 'resume-member-1', name: 'Member resume-member-1', email: 'resumemember@example.com', accountStatus: 'scheduled' },
      ],
    })
    await adminDb.doc(`companies/${companyId}/bookings/b1`).set({ title: 'Pre-existing booking' })

    const db = getTestFunctionsDb()
    await runCompanyPurge(db, requestId)

    const ledgerSnap = await adminDb.doc(`companyDeletions/${requestId}`).get()
    const ledger = ledgerSnap.data()!
    expect(ledger.state).toBe('completed')
    // completedPhases must never lose 'members' — proof it wasn't re-derived
    // from scratch, only appended to.
    expect(ledger.completedPhases).toEqual(
      expect.arrayContaining(['stripe', 'invitations', 'members', 'subtree', 'orphans']),
    )
    // attempts stays at 0 — this run didn't fail, it just picked up where a
    // (simulated) prior attempt left off.
    expect(ledger.attempts).toBe(0)

    // End result identical to an uninterrupted run: company gone, its
    // subtree gone, exactly one 'companyDeleted' mail for the one member
    // captured before the (simulated) crash.
    const companySnap = await adminDb.doc(`companies/${companyId}`).get()
    expect(companySnap.exists).toBe(false)

    const bookingSnap = await adminDb.doc(`companies/${companyId}/bookings/b1`).get()
    expect(bookingSnap.exists).toBe(false)

    const mailSnap = await adminDb
      .collection('mail')
      .where('template', '==', 'companyDeleted')
      .where('to', '==', 'resumemember@example.com')
      .get()
    expect(mailSnap.size).toBe(1)
  })

  it('a crash mid-subtree records attempts/lastError, keeps prior phases, then resumes cleanly', async () => {
    const companyId = 'resume-fail-co'
    const requestId = 'resume-fail-req'

    await seedRequestedDeletion(adminDb, { companyId, requestId })
    await seedMember(adminDb, companyId, 'resume-fail-member-1', { email: 'resumefail@example.com' })
    await adminDb.doc(`companies/${companyId}/bookings/b1`).set({ title: 'Booking' })

    const db = getTestFunctionsDb()

    // Force the FIRST recursiveDelete call (subtree phase, first collection)
    // to throw, simulating a crash after stripe/invitations/members already
    // committed. Restored after one call so the resumed run proceeds for
    // real.
    const spy = vi.spyOn(db, 'recursiveDelete').mockImplementationOnce(() => {
      throw new Error('simulated crash mid-subtree')
    })

    await runCompanyPurge(db, requestId)

    const afterFailure = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(afterFailure.attempts).toBe(1)
    expect(afterFailure.lastError).toContain('simulated crash mid-subtree')
    expect(afterFailure.state).not.toBe('failed') // budget not exhausted yet
    expect(afterFailure.completedPhases).toEqual(
      expect.arrayContaining(['stripe', 'invitations', 'members']),
    )
    expect(afterFailure.completedPhases).not.toContain('subtree')

    spy.mockRestore()

    // Resume — completes for real this time.
    await runCompanyPurge(db, requestId)

    const afterResume = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(afterResume.state).toBe('completed')
    expect(afterResume.completedPhases).toEqual(
      expect.arrayContaining(['stripe', 'invitations', 'members', 'subtree', 'orphans']),
    )

    const bookingSnap = await adminDb.doc(`companies/${companyId}/bookings/b1`).get()
    expect(bookingSnap.exists).toBe(false)

    const mailSnap = await adminDb
      .collection('mail')
      .where('template', '==', 'companyDeleted')
      .where('to', '==', 'resumefail@example.com')
      .get()
    // Exactly one — the crashed attempt never reached finalize, so it never
    // queued a duplicate.
    expect(mailSnap.size).toBe(1)
  })

  it('resumes mid-members-phase: an already-processed uid is not reprocessed, the remaining one still is', async () => {
    const companyId = 'resume-members-co'
    const requestId = 'resume-members-req'

    await seedRequestedDeletion(adminDb, {
      companyId,
      requestId,
      completedPhases: ['stripe', 'invitations'], // members NOT yet marked complete
    })
    // Two members — uid-1 already appears in formerMemberContacts (as if a
    // prior attempt crashed partway through the members loop, right after
    // committing uid-1 and before starting uid-2). Neither has a real Auth
    // user; cleanupOneMember's Auth calls are non-fatal on failure (see its
    // own docblock), so this only exercises the Firestore-side resume
    // marker, which is the thing under test here.
    await seedMember(adminDb, companyId, 'resume-members-uid-1', { email: 'rm1@example.com' })
    await seedMember(adminDb, companyId, 'resume-members-uid-2', { email: 'rm2@example.com' })
    await adminDb.doc(`companyDeletions/${requestId}`).update({
      formerMemberContacts: [
        { uid: 'resume-members-uid-1', name: 'Member resume-members-uid-1', email: 'rm1@example.com', accountStatus: 'scheduled' },
      ],
    })
    // uid-1's membership doc already removed and her account already
    // scheduled by the (simulated) prior attempt — with a MATCHING audit
    // entry pre-seeded. Both must stay untouched (no second audit entry) if
    // the per-uid resume marker actually works.
    await adminDb.doc(`users/resume-members-uid-1/memberships/${companyId}`).delete()
    const ledgerBefore = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    await adminDb.doc('users/resume-members-uid-1').set(
      { pendingDeletion: { scheduledFor: ledgerBefore.scheduledFor, requestId } },
      { merge: true },
    )
    const uid1Hash = createHash('sha256').update('resume-members-uid-1').digest('hex')
    await adminDb.collection('deletionAuditLog').add({
      userIdHash: uid1Hash,
      requestId,
      companyId,
      triggeredBy: 'company_deletion_stranded_member',
    })

    const db = getTestFunctionsDb()
    await runCompanyPurge(db, requestId)

    // uid-1: still exactly the ONE pre-seeded audit entry — the resumed run
    // must not have reprocessed her and written a second one.
    const auditSnap1 = await adminDb
      .collection('deletionAuditLog')
      .where('requestId', '==', requestId)
      .where('userIdHash', '==', uid1Hash)
      .get()
    expect(auditSnap1.size).toBe(1)

    // uid-2: newly processed by this resumed run — her membership is gone
    // and she now has a pendingDeletion + one audit entry.
    const membership2 = await adminDb.doc(`users/resume-members-uid-2/memberships/${companyId}`).get()
    expect(membership2.exists).toBe(false)
    const user2 = await adminDb.doc('users/resume-members-uid-2').get()
    expect(user2.data()?.pendingDeletion).toBeTruthy()

    const ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.formerMemberContacts).toHaveLength(2)
    expect(ledger.state).toBe('completed')
  })

  it('marks the ledger failed once attempts reaches the five-attempt budget', async () => {
    const companyId = 'resume-budget-co'
    const requestId = 'resume-budget-req'

    await seedRequestedDeletion(adminDb, { companyId, requestId, attempts: 4 })

    const db = getTestFunctionsDb()
    const spy = vi.spyOn(db, 'recursiveDelete').mockImplementation(() => {
      throw new Error('simulated permanent failure')
    })

    await runCompanyPurge(db, requestId)

    const ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.attempts).toBe(5)
    expect(ledger.state).toBe('failed')

    spy.mockRestore()
  })
})
