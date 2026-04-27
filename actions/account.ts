'use server'

import { revalidatePath } from 'next/cache'
import { adminAuth, adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { deleteSession } from './auth'

export async function updateUserProfile(data: {
  name?: string
  defaultBookingView?: 'list' | 'week' | 'month' | '4weeks'
}): Promise<{ error?: string }> {
  const session = await getVerifiedSession()

  try {
    await adminDb.collection('users').doc(session.uid).update(data)
    revalidatePath('/settings/account')
    console.log('[actions/account]', { uid: session.uid.slice(0, 8) + '...', action: 'profile_updated' })
    return {}
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/account]', { error: message, action: 'update_profile_failed' })
    return { error: 'Failed to save profile' }
  }
}

export async function deleteAccount(): Promise<{ error?: string }> {
  const session = await getVerifiedSession()

  // Last-admin guard: block deletion if this user is the sole admin of ANY company
  // they belong to — not just the active one (fixes issue #90).
  try {
    const membershipsSnap = await adminDb.collection('users').doc(session.uid).collection('memberships').get()
    const adminMemberships = membershipsSnap.docs.filter(m => m.data().role === 'admin')

    if (adminMemberships.length > 0) {
      const adminCounts = await Promise.all(
        adminMemberships.map(async (m) => {
          const companyId = m.data().companyId as string
          const countSnap = await adminDb
            .collectionGroup('memberships')
            .where('companyId', '==', companyId)
            .where('role', '==', 'admin')
            .count()
            .get()
          return { companyId, count: countSnap.data().count }
        })
      )
      const blocking = adminCounts.find(c => c.count <= 1)
      if (blocking) {
        console.error('[actions/account] deleteAccount blocked: sole admin', { uid: session.uid.slice(0, 8) + '...' })
        return { error: 'Cannot delete account: you are the only admin of one of your companies. Transfer ownership first.' }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/account]', { error: message, action: 'delete_account_guard_failed' })
    return { error: 'Failed to delete account' }
  }

  // Step 1: clear the session cookie — user is logged out regardless of what follows.
  try {
    await deleteSession()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/account]', { error: message, action: 'delete_account_session_failed' })
    return { error: 'Failed to delete account' }
  }

  // Step 2: delete Firestore doc. Log on failure but continue — session is already cleared.
  try {
    await adminDb.collection('users').doc(session.uid).delete()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/account]', { uid: session.uid.slice(0, 8) + '...', error: message, action: 'delete_firestore_doc_failed' })
  }

  // Step 3: delete Auth user. Log on failure — session is already cleared.
  try {
    await adminAuth.deleteUser(session.uid)
    console.log('[actions/account]', { uid: session.uid.slice(0, 8) + '...', action: 'account_deleted' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/account]', { uid: session.uid.slice(0, 8) + '...', error: message, action: 'delete_auth_user_failed' })
  }

  return {}
}
