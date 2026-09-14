/**
 * "Svepets lease" — issue #252 step 5, PR E. Two overlapping sweep
 * invocations racing the same overdue company must start the purge exactly
 * once. The plan is explicit that the guard is the transaction, not the
 * sweep's 30-minute cadence — this test simulates the race directly by
 * calling `runCompanyDeletionSweep` twice concurrently against one seeded
 * overdue request.
 */
import { describe, expect, it } from 'vitest'
import { adminDb } from '@/lib/firebase-admin'
import { runCompanyDeletionSweep } from '../../functions/src/company/sweep'
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
})
