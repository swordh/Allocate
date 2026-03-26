'use server'

// Full implementation in Phase 5.

import { getVerifiedSession } from '@/lib/dal'
import type { Role } from '@/types'

export async function inviteUser(_formData: FormData): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }
  console.log('[actions/team]', { uid: session.uid.slice(0, 8) + '...', action: 'invite_user_stub' })
  return { error: 'Not implemented — Phase 5' }
}

export async function updateMemberRole(
  _memberId: string,
  _newRole: Role,
): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }
  console.log('[actions/team]', { uid: session.uid.slice(0, 8) + '...', action: 'update_member_role_stub' })
  return { error: 'Not implemented — Phase 5' }
}

export async function removeMember(_memberId: string): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }
  console.log('[actions/team]', { uid: session.uid.slice(0, 8) + '...', action: 'remove_member_stub' })
  return { error: 'Not implemented — Phase 5' }
}
