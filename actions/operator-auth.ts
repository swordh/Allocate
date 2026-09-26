'use server'

import { cookies } from 'next/headers'
import { adminAuth } from '@/lib/firebase-admin'
import { isOperator } from '@/lib/operator-dal'
import { writeOperatorLoginLog } from '@/lib/operator-login-log'

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
 *
 * Every attempt is logged to `operatorLoginLog` (issue #344) — the rule is
 * "no access without an audit trail":
 *   - `invalid_token`: no identity to record, console-only.
 *   - `not_operator`: logged with uid + email BEFORE returning denied. If
 *     this log write itself fails, the error is swallowed and console-logged
 *     — the result stays denied either way, so there is nothing more this
 *     path can do to enforce the audit-trail rule.
 *   - `granted`: logged AFTER `createSessionCookie` succeeds but BEFORE the
 *     cookie is actually set on the response. If THIS write fails, the login
 *     is denied and no cookie is set — an operator session must never exist
 *     without a corresponding audit row.
 */
export async function operatorSignIn(idToken: string): Promise<{ ok: boolean }> {
  let decoded
  try {
    decoded = await adminAuth.verifyIdToken(idToken)
  } catch {
    // No identity was ever established — nothing to log to Firestore.
    console.error('[operator-auth]', { action: 'login_denied', reason: 'invalid_token' })
    return { ok: false }
  }

  const uid = decoded.uid
  const email = decoded.email ?? ''

  if (!(await isOperator(uid))) {
    console.error('[operator-auth]', { action: 'login_denied', reason: 'not_operator' })
    try {
      await writeOperatorLoginLog({ uid, email, outcome: 'denied', reason: 'not_operator' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[operator-auth]', { action: 'login_log_failed', reason: 'not_operator', error: message })
    }
    return { ok: false }
  }

  try {
    const sessionCookie = await adminAuth.createSessionCookie(idToken, {
      expiresIn: SESSION_DURATION_MS,
    })

    // The audit row must exist before access is granted — if this write
    // fails, deny the login and set no cookie rather than grant access with
    // no trace of it.
    try {
      await writeOperatorLoginLog({ uid, email, outcome: 'granted', reason: 'operator' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[operator-auth]', { action: 'login_denied', reason: 'audit_log_failed', error: message })
      return { ok: false }
    }

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
