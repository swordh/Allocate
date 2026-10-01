import 'server-only'

import { cache } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { adminAuth } from '@/lib/firebase-admin'

const OPERATOR_ALLOWLIST = ['jocke@allocate.at']

export interface OperatorSession {
  uid: string
  email: string
}

/**
 * The one operator check — provider:true custom claim AND email allowlist.
 * Shared by getOperatorSession (session-cookie path) and the /operator/login
 * server action (fresh-ID-token path, before any session cookie exists), so
 * both gates stay identical by construction instead of by copy-paste.
 *
 * Deliberately takes only the two claims it needs rather than a full
 * DecodedIdToken, so it works for both a verifySessionCookie() result and a
 * verifyIdToken() result without a type union.
 */
export function isOperator(claims: { provider?: unknown; email?: string | null }): boolean {
  if (claims.provider !== true) return false
  const email = claims.email ?? ''
  return OPERATOR_ALLOWLIST.includes(email)
}

/**
 * Verifies the __session cookie and checks for provider:true custom claim.
 * Also enforces an email allowlist for extra security.
 * Redirects to /login if the cookie is missing, invalid, or unauthorized.
 *
 * Wrapped in React.cache — multiple Server Components calling this in the
 * same render pass incur only one Admin SDK verification call.
 */
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

export const getOperatorSession = cache(async (): Promise<OperatorSession> => {
  const cookieStore = await cookies()
  const sessionCookie = cookieStore.get('__session')?.value

  if (!sessionCookie) {
    console.error('[operator-dal] session_cookie_missing')
    redirect('/login')
  }

  try {
    const decoded = await adminAuth.verifySessionCookie(sessionCookie, true)

    if (!isOperator(decoded)) {
      console.error('[operator-dal] session_failed_operator_check')
      redirect('/login')
    }

    return {
      uid: decoded.uid,
      email: decoded.email ?? '',
    }
  } catch (err) {
    // Re-throw Next.js redirect errors so they propagate to the framework.
    // In production, redirect() throws an error with a NEXT_REDIRECT digest.
    // In test, the mock throws Error('REDIRECT:…'). Both must pass through.
    const digest = (err as { digest?: string }).digest ?? ''
    const msg    = err instanceof Error ? err.message : ''
    if (digest.startsWith('NEXT_REDIRECT') || msg.startsWith('REDIRECT:')) throw err
    // Do not log the raw error — Firebase session errors can contain tokens or emails.
    console.error('[operator-dal] session_cookie_invalid')
    redirect('/login')
  }
})
