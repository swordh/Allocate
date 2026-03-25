'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { adminAuth, adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'

// 14 days in milliseconds — matches the Firebase session cookie maximum.
const SESSION_DURATION_MS = 60 * 60 * 24 * 14 * 1000

/**
 * Creates a Firebase session cookie from a client-supplied ID token.
 * Called after successful signInWithEmailAndPassword on the client.
 */
export async function createSession(idToken: string): Promise<void> {
  let uid: string | undefined

  try {
    const decodedToken = await adminAuth.verifyIdToken(idToken)
    uid = decodedToken.uid

    const sessionCookie = await adminAuth.createSessionCookie(idToken, {
      expiresIn: SESSION_DURATION_MS,
    })

    const cookieStore = await cookies()
    cookieStore.set('__session', sessionCookie, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path:     '/',
      maxAge:   60 * 60 * 24 * 14, // 14 days in seconds
    })

    console.log('[actions/auth]', { action: 'session_created' })
  } catch (err) {
    // Do not log the raw error — Firebase Admin errors can contain emails or tokens.
    const code = err instanceof Error ? (err.message.split('/').pop() ?? 'unknown') : 'unknown'
    console.error('[actions/auth]', { code, action: 'create_session_failed' })
    throw new Error('Failed to create session')
  }
}

/**
 * Clears the session cookie. Call this on sign-out.
 */
export async function deleteSession(): Promise<void> {
  try {
    const cookieStore = await cookies()
    cookieStore.delete('__session')
    console.log('[actions/auth]', { action: 'session_deleted' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/auth]', { error: message, action: 'delete_session_failed' })
    throw new Error('Failed to delete session')
  }
}

/**
 * Switches the active company for the current user.
 * Validates that a membership document exists for the target companyId before
 * updating claims.
 *
 * IMPORTANT: After calling this action the caller MUST:
 *   1. Call `auth.currentUser.getIdToken(true)` to force a token refresh
 *   2. Call `createSession(freshIdToken)` to re-issue the session cookie
 * Skipping these steps leaves the session cookie carrying stale claims
 * (old activeCompanyId) until it expires — which is a security defect.
 */
export async function switchCompany(companyId: string): Promise<void> {
  const session = await getVerifiedSession()
  const uid = session.uid

  try {
    // Verify membership exists before updating claims.
    const membershipRef = adminDb
      .collection('users').doc(uid)
      .collection('memberships').doc(companyId)

    const membershipSnap = await membershipRef.get()

    if (!membershipSnap.exists) {
      console.error('[actions/auth]', { uid, companyId, action: 'switch_company_denied_no_membership' })
      throw new Error('No membership found for this company')
    }

    const membershipData = membershipSnap.data() as { role?: string }
    const role = membershipData.role ?? 'viewer'

    await adminAuth.setCustomUserClaims(uid, {
      activeCompanyId: companyId,
      role,
    })

    console.log('[actions/auth]', { uid, companyId, role, action: 'company_switched' })

    // Invalidate all cached server data so the new company's data is loaded.
    revalidatePath('/', 'layout')
  } catch (err) {
    const code = err instanceof Error ? (err.message.split('/').pop() ?? 'unknown') : 'unknown'
    console.error('[actions/auth]', { code, action: 'switch_company_failed' })
    throw new Error('Failed to switch company')
  }
}
