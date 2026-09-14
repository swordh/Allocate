/**
 * "Svepets lease" — issue #252 step 5, PR E. Two overlapping sweep
 * invocations racing the same overdue company must start the purge exactly
 * once. The plan is explicit that the guard is the transaction, not the
 * sweep's 30-minute cadence — this test simulates the race directly by
 * calling `runCompanyDeletionSweep` twice concurrently against one seeded
 * overdue request.
 */
import { Timestamp } from 'firebase-admin/firestore'
import { describe, expect, it } from 'vitest'
import { adminDb } from '@/lib/firebase-admin'
import { runCompanyDeletionSweep } from '../../functions/src/company/sweep'
import { handleCompanyDeletionCreated } from '../../functions/src/company/onDeletionCreated'
import { getTestFunctionsDb } from '../../functions/src/testSupport/emulatorInit'
import { seedRequestedDeletion, seedMember } from './companyDeletionFixtures'

describe('company deletion sweep — lease', () => {
  it('two concurrent sweeps against the same overdue company start exactly one purge', async () => {
    const companyId = 'lease-co'
    const requestId = 'lease-req'

    await seedRequestedDeletion(adminDb, { companyId, requestId })
    await seedMember(adminDb, companyId, 'lease-member-1', { email: 'member1@example.com' })

    const db = getTestFunctionsDb()

    const [a, b] = await Promise.all([runCompanyDeletionSweep(db), runCompanyDeletionSweep(db)])

    // Across the two overlapping calls, exactly one of them actually won
    // the lease and ran the purge to completion.
    expect(a.executed + b.executed).toBe(1)

    const companySnap = await adminDb.doc(`companies/${companyId}`).get()
    expect(companySnap.exists).toBe(false)

    const ledgerSnap = await adminDb.doc(`companyDeletions/${requestId}`).get()
    expect(ledgerSnap.data()?.state).toBe('completed')

    // If the purge had somehow run twice, this member would have two
    // 'companyDeleted' mail docs queued instead of one — the structural
    // proof that the second run's lease claim was refused before it ever
    // reached the members/finalize phases.
    const mailSnap = await adminDb
      .collection('mail')
      .where('template', '==', 'companyDeleted')
      .where('to', '==', 'member1@example.com')
      .get()
    expect(mailSnap.size).toBe(1)
  })

  it('immediate-mode trigger racing the sweep starts exactly one purge (blocker 2)', async () => {
    // onCompanyDeletionCreated's mode:'immediate' branch used to call
    // runCompanyPurge with no lease claim at all — an immediate request's
    // scheduledFor is in the past from the moment it's created, so
    // executeOverdue matches it from the very first sweep tick. Simulates
    // the trigger firing at the same moment a sweep run reaches the same
    // company.
    const companyId = 'lease-immediate-co'
    const requestId = 'lease-immediate-req'

    await seedRequestedDeletion(adminDb, { companyId, requestId })
    await adminDb.doc(`companies/${companyId}`).update({ 'deletion.mode': 'immediate' })
    await adminDb.doc(`companyDeletions/${requestId}`).update({ mode: 'immediate' })
    await seedMember(adminDb, companyId, 'lease-immediate-member-1', { email: 'immediatemember@example.com' })

    const db = getTestFunctionsDb()
    const ledgerSnap = await adminDb.doc(`companyDeletions/${requestId}`).get()
    const ledger = ledgerSnap.data() as Parameters<typeof handleCompanyDeletionCreated>[2]

    await Promise.all([
      handleCompanyDeletionCreated(db, requestId, ledger),
      runCompanyDeletionSweep(db),
    ])

    const finalLedger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(finalLedger.state).toBe('completed')
    expect((await adminDb.doc(`companies/${companyId}`).get()).exists).toBe(false)

    const mailSnap = await adminDb
      .collection('mail')
      .where('template', '==', 'companyDeleted')
      .where('to', '==', 'immediatemember@example.com')
      .get()
    expect(mailSnap.size).toBe(1)
  })

  it('two concurrent resumeStuck passes over the same stale lease start exactly one purge (blocker 3)', async () => {
    // resumeStuck used to call runCompanyPurge for every stale-heartbeat hit
    // with no compare-and-swap — Cloud Scheduler is at-least-once, so two
    // overlapping sweep runs both finding the same stuck lease is a real
    // possibility. Seeds a ledger already 'executing' with a heartbeat well
    // past the stale threshold, then races two full sweep calls against it.
    const companyId = 'lease-resume-co'
    const requestId = 'lease-resume-req'

    await seedRequestedDeletion(adminDb, { companyId, requestId })
    await seedMember(adminDb, companyId, 'lease-resume-member-1', { email: 'resumemember2@example.com' })

    const staleHeartbeat = Timestamp.fromMillis(Date.now() - 2 * 60 * 60 * 1000) // 2h ago, past the 60min stale threshold
    await adminDb.doc(`companies/${companyId}`).update({ 'deletion.state': 'executing' })
    await adminDb.doc(`companyDeletions/${requestId}`).update({
      state: 'executing',
      lastHeartbeatAt: staleHeartbeat,
      completedPhases: ['stripe', 'invitations'], // members not yet run
    })

    const db = getTestFunctionsDb()

    const [a, b] = await Promise.all([runCompanyDeletionSweep(db), runCompanyDeletionSweep(db)])
    expect(a.resumed + b.resumed).toBeGreaterThanOrEqual(1)

    const finalLedger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(finalLedger.state).toBe('completed')

    const mailSnap = await adminDb
      .collection('mail')
      .where('template', '==', 'companyDeleted')
      .where('to', '==', 'resumemember2@example.com')
      .get()
    // The structural proof: if both sweeps had resumed the same stuck lease
    // concurrently, this member would have two mail docs, not one.
    expect(mailSnap.size).toBe(1)
  })
})
