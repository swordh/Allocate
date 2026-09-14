/**
 * "Medlemsstädningen" and "Kontoschemaläggningen" — issue #252 step 5, PR E.
 *
 *  - A member with another company: her membership pointer into the purged
 *    company is removed, but her account is untouched — no `pendingDeletion`.
 *  - A member with NO other company: stranded. The purge does not delete her
 *    — it schedules her account for deletion thirty days out
 *    (`users/{uid}.pendingDeletion`), and she remains fully present in both
 *    Auth and Firestore.
 *  - `setupNewCompany` (actions/auth.ts) — the real, unmodified server
 *    action, not a stand-in — still succeeds for a stranded member. PR E
 *    does not harden it to clear `pendingDeletion` (that's PR F's job per
 *    the plan's "Avbrottsvillkoret"), but nothing about the schedule
 *    written here should make the existing create-company path start
 *    failing for her.
 */
import { describe, expect, it } from 'vitest'
import { adminAuth, adminDb } from '@/lib/firebase-admin'
import { setupNewCompany } from '@/actions/auth'
import { runCompanyPurge } from '../../functions/src/company/purge'
import { getTestFunctionsDb } from '../../functions/src/testSupport/emulatorInit'
import { getIdTokenForUid } from './authHelpers'
import { seedRequestedDeletion, seedMember } from './companyDeletionFixtures'

describe('company purge — member cleanup and account scheduling', () => {
  it('kept: a member with another company loses only the purged membership', async () => {
    const companyId = 'member-co'
    const otherCompanyId = 'member-other-co'
    const requestId = 'member-req'
    const uid = 'kept-member-uid'

    await adminAuth.createUser({ uid, email: 'kept@example.com' })
    await seedRequestedDeletion(adminDb, { companyId, requestId })
    await seedMember(adminDb, companyId, uid, { email: 'kept@example.com', otherCompanyId })

    const db = getTestFunctionsDb()
    await runCompanyPurge(db, requestId)

    const membershipSnap = await adminDb.doc(`users/${uid}/memberships/${companyId}`).get()
    expect(membershipSnap.exists).toBe(false)

    const otherMembershipSnap = await adminDb.doc(`users/${uid}/memberships/${otherCompanyId}`).get()
    expect(otherMembershipSnap.exists).toBe(true)

    const userSnap = await adminDb.doc(`users/${uid}`).get()
    expect(userSnap.data()?.pendingDeletion).toBeUndefined()
    expect(userSnap.data()?.activeCompanyId).toBe(otherCompanyId)

    // Still a real Auth user — nothing here deletes her.
    const authUser = await adminAuth.getUser(uid)
    expect(authUser).toBeTruthy()
  })

  it('scheduled: a stranded member gets a thirty-day pendingDeletion and stays in Auth + Firestore', async () => {
    const companyId = 'stranded-co'
    const requestId = 'stranded-req'
    const uid = 'stranded-member-uid'

    await adminAuth.createUser({ uid, email: 'stranded@example.com' })
    await seedRequestedDeletion(adminDb, { companyId, requestId })
    await seedMember(adminDb, companyId, uid, { email: 'stranded@example.com' })

    const beforePurge = Date.now()
    const db = getTestFunctionsDb()
    await runCompanyPurge(db, requestId)
    const afterPurge = Date.now()

    const userSnap = await adminDb.doc(`users/${uid}`).get()
    expect(userSnap.exists).toBe(true)
    const pendingDeletion = userSnap.data()?.pendingDeletion
    expect(pendingDeletion).toBeTruthy()
    expect(pendingDeletion.requestId).toBe(requestId)

    const scheduledForMs = pendingDeletion.scheduledFor.toDate().getTime()
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
    // Within a small tolerance of "now + 30 days", computed around the purge call.
    expect(scheduledForMs).toBeGreaterThanOrEqual(beforePurge + THIRTY_DAYS_MS - 5_000)
    expect(scheduledForMs).toBeLessThanOrEqual(afterPurge + THIRTY_DAYS_MS + 5_000)

    // Still fully present — nothing deleted her account or Auth record.
    const authUser = await adminAuth.getUser(uid)
    expect(authUser.email).toBe('stranded@example.com')

    // Distinct audit trail entry from self-service deleteAccount.
    const auditSnap = await adminDb
      .collection('deletionAuditLog')
      .where('requestId', '==', requestId)
      .get()
    expect(auditSnap.size).toBe(1)
    expect(auditSnap.docs[0].data().triggeredBy).toBe('company_deletion_stranded_member')
  })

  it('setupNewCompany still succeeds for a stranded, scheduled-for-deletion member', async () => {
    const companyId = 'stranded-setup-co'
    const requestId = 'stranded-setup-req'
    const uid = 'stranded-setup-uid'

    await adminAuth.createUser({ uid, email: 'strandedsetup@example.com' })
    await seedRequestedDeletion(adminDb, { companyId, requestId })
    await seedMember(adminDb, companyId, uid, { email: 'strandedsetup@example.com' })

    const db = getTestFunctionsDb()
    await runCompanyPurge(db, requestId)

    const userSnapBefore = await adminDb.doc(`users/${uid}`).get()
    expect(userSnapBefore.data()?.pendingDeletion).toBeTruthy()

    const idToken = await getIdTokenForUid(uid)
    await expect(setupNewCompany(idToken, 'Her New Company', 'Stranded Member')).resolves.toBeUndefined()

    const newMembershipsSnap = await adminDb.collection(`users/${uid}/memberships`).get()
    expect(newMembershipsSnap.size).toBe(1)
  })
})
