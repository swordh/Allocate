'use server'

import { cookies } from 'next/headers'
import { adminAuth } from '@/lib/firebase-admin'
import { isOperator } from '@/lib/operator-dal'

// 14 days in milliseconds — matches the Firebase session cookie maximum.
const SESSION_DURATION_MS = 60 * 60 * 24 * 14 * 1000

/**
 * Verifies a freshly-signed-in Firebase user against the operator check
 * (lib/operator-dal.ts → isOperator) and only then issues the __session
 * cookie. Unlike actions/auth.ts → createSession, this refuses to set a
 * cookie at all when the check fails — a non-operator who successfully
 * authenticates with Firebase must not get a session, generic or otherwise.
 *
 * The caller (OperatorLoginForm) is responsible for signing the client-side
 * Firebase Auth user back out when this returns { ok: false }, since Firebase
 * Auth state is already established client-side by the time this runs.
 */
export async function operatorSignIn(idToken: string): Promise<{ ok: boolean }> {
  let decoded
  try {
    decoded = await adminAuth.verifyIdToken(idToken)
  } catch {
    console.error('[operator-auth]', { action: 'login_denied', reason: 'invalid_token' })
    return { ok: false }
  }

  if (!isOperator(decoded)) {
    console.error('[operator-auth]', { action: 'login_denied', reason: 'not_operator' })
    return { ok: false }
  }

  try {
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

    console.log('[operator-auth]', { action: 'login_success' })
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[operator-auth]', { action: 'session_create_failed', error: message })
    return { ok: false }
  }
}
