import 'server-only'

import { cache } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { adminAuth, adminDb } from '@/lib/firebase-admin'

export interface OperatorSession {
  uid: string
  email: string
}

/**
 * The one operator check — issue #344. Previously this was a custom claim
 * (`provider === true`) AND an email allowlist, both rejected:
 *
 *   - The claim was overwritten wholesale by any of the 11 other
 *     `setCustomUserClaims` call sites in this codebase (actions/auth.ts,
 *     actions/team.ts, functions/src/auth/acceptInvitation.ts,
 *     functions/src/company/memberCleanup.ts) — none of them know about or
 *     preserve `provider`, so an operator's own claim could silently vanish
 *     the moment she switched companies or was re-invited somewhere.
 *   - Revoking access via a claim only takes effect once the 14-day session
 *     cookie the claim was baked into actually expires (or an explicit
 *     `revokeRefreshTokens` call, which nothing here made) — up to two weeks
 *     of lag on a security-sensitive gate.
 *   - The hardcoded `OPERATOR_ALLOWLIST` needed a code change + deploy to
 *     add or remove an operator.
 *
 * Operator status is now a plain Firestore doc, `operators/{uid}`, read
 * server-side via the Admin SDK on every check — no claim, no allowlist, no
 * cookie lag: revoking access (deleting the doc) takes effect on that uid's
 * very next request. Managed with `tools/set-operator.js`.
 *
 * Fails closed: a Firestore read error is logged and treated as "not an
 * operator", never as "presumed operator".
 */
export async function isOperator(uid: string): Promise<boolean> {
  try {
    const snap = await adminDb.collection('operators').doc(uid).get()
    return snap.exists
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[operator-dal]', { action: 'operator_check_failed', error: message })
    return false
  }
}

/**
 * Re-throws Next.js's internal redirect signal so it can propagate to the
 * framework instead of being swallowed by a server action's try/catch.
 * `redirect()` throws an error carrying a `NEXT_REDIRECT` digest in
 * production; the test mock throws `Error('REDIRECT:…')` instead — both
 * forms have to pass through untouched.
 *
 * Previously duplicated verbatim in app/operator/feedback/actions.ts,
 * app/operator/feedback/[id]/actions.ts, and
 * app/operator/customers/[companyId]/actions.ts — hoisted here as the one copy.
 */
export function rethrowRedirect(err: unknown): void {
  const digest = (err as { digest?: string }).digest ?? ''
  const msg = err instanceof Error ? err.message : ''
  if (digest.startsWith('NEXT_REDIRECT') || msg.startsWith('REDIRECT:')) throw err
}

/**
 * Verifies the __session cookie and checks `operators/{uid}` in Firestore
 * (see `isOperator` above). Redirects to /login if the cookie is missing,
 * invalid, or the uid is not an operator.
 *
 * Wrapped in React.cache — multiple Server Components calling this in the
 * same render pass incur only one Admin SDK verification call.
 */
export const getOperatorSession = cache(async (): Promise<OperatorSession> => {
  const cookieStore = await cookies()
  const sessionCookie = cookieStore.get('__session')?.value

  if (!sessionCookie) {
    console.error('[operator-dal] session_cookie_missing')
    redirect('/login')
  }

  try {
    const decoded = await adminAuth.verifySessionCookie(sessionCookie, true)

    if (!(await isOperator(decoded.uid))) {
      console.error('[operator-dal] session_failed_operator_check')
      redirect('/login')
    }

    return {
      uid: decoded.uid,
      email: decoded.email ?? '',
    }
  } catch (err) {
    rethrowRedirect(err)
    // Do not log the raw error — Firebase session errors can contain tokens or emails.
    console.error('[operator-dal] session_cookie_invalid')
    redirect('/login')
  }
})
