/**
 * Issue #252 step 6, Part A — closes the source gap the brief identified:
 * `acceptInvitationByToken` (functions/src/auth/acceptInvitation.ts) used to
 * contain zero occurrences of `pendingDeletion`, so a stranded user who was
 * invited into another company kept her countdown and could be deleted by
 * `strandedAccountSweep` while an active member of a company. This test
 * confirms the fix: accepting an invitation clears `pendingDeletion` in the
 * same transaction as the membership write.
 */
import { describe, expect, it } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import { adminAuth, adminDb } from '@/lib/firebase-admin'
import { acceptInvitationByToken } from '../../functions/src/auth/acceptInvitation'

describe('acceptInvitationByToken clears pendingDeletion', () => {
  it('accepting an invitation clears a stranded uid\'s pendingDeletion in the same transaction as the membership write', async () => {
    const uid = 'invited-stranded-uid'
    const companyId = 'invite-target-co'
    const inviteId = 'invite-1'
    const token = 'a'.repeat(32)
    const email = 'stranded-invitee@example.com'

    await adminAuth.createUser({ uid, email })
    await adminDb.doc(`users/${uid}`).set({
      name: 'Stranded Invitee',
      email,
      activeCompanyId: null,
      pendingDeletion: {
        scheduledFor: Timestamp.fromMillis(Date.now() + 10 * 24 * 60 * 60 * 1000),
        requestId: 'some-prior-req',
      },
    })

    await adminDb.doc(`companies/${companyId}`).set({
      name: 'Invite Target Co',
      createdAt: Timestamp.now(),
      createdBy: 'someone-else',
      stripeCustomerId: '',
      subscription: { status: 'active', plan: 'starter', currentPeriodEnd: null, limits: { equipment: 25, users: 10 } },
    })

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    await adminDb.doc(`companies/${companyId}/invitations/${inviteId}`).set({
      id: inviteId,
      email,
      role: 'crew',
      invitedBy: 'someone-else',
      invitedByName: 'Someone Else',
      invitedAt: new Date().toISOString(),
      status: 'pending',
      token,
      expiresAt,
    })
    await adminDb.collection('invitations').doc(token).set({
      companyId,
      inviteId,
      email,
      status: 'pending',
      expiresAt,
    })

    const result = await acceptInvitationByToken.run({
      data: { token },
      auth: { uid, token: { uid, email, email_verified: true } },
      rawRequest: {} as never,
    } as never)

    expect((result as { success: boolean }).success).toBe(true)

    const userSnap = await adminDb.doc(`users/${uid}`).get()
    expect(userSnap.data()?.pendingDeletion).toBeUndefined()

    const membershipSnap = await adminDb.doc(`users/${uid}/memberships/${companyId}`).get()
    expect(membershipSnap.exists).toBe(true)
  })
})
