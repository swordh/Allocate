'use server'

import { revalidatePath } from 'next/cache'
import { adminAuth, adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import type { Role } from '@/types'

export async function inviteUser(_formData: FormData): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }
  console.log('[actions/team]', { uid: session.uid.slice(0, 8) + '...', action: 'invite_user_stub' })
  return { error: 'Not implemented — Phase 5' }
}

export async function updateMemberRole(
  memberId: string,
  newRole: Role,
): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  const validRoles: Role[] = ['admin', 'crew', 'viewer']
  if (!validRoles.includes(newRole)) return { error: 'Invalid role' }

  if (memberId === session.uid) return { error: "You can't change your own role" }

  const companyId = session.activeCompanyId

  const memberRef         = adminDb.doc(`companies/${companyId}/members/${memberId}`)
  const userMembershipRef = adminDb.doc(`users/${memberId}/memberships/${companyId}`)

  const batch = adminDb.batch()
  batch.update(memberRef, { role: newRole })
  batch.update(userMembershipRef, { role: newRole })
  await batch.commit()

  const authUser = await adminAuth.getUser(memberId)
  const claims = (authUser.customClaims ?? {}) as Record<string, unknown>
  if (claims['activeCompanyId'] === companyId) {
    await adminAuth.setCustomUserClaims(memberId, {
      activeCompanyId: companyId,
      role: newRole,
    })
  }

  revalidatePath('/settings/team')
  return {}
}

export async function removeMember(_memberId: string): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }
  console.log('[actions/team]', { uid: session.uid.slice(0, 8) + '...', action: 'remove_member_stub' })
  return { error: 'Not implemented — Phase 5' }
}
