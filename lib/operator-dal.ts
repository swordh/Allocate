import 'server-only'

import { cache } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { adminAuth } from '@/lib/firebase-admin'

const OPERATOR_ALLOWLIST = ['swordh@gmail.com']

export interface OperatorSession {
  uid: string
  email: string
}

/**
 * Verifies the __session cookie and checks for provider:true custom claim.
 * Also enforces an email allowlist for extra security.
 * Redirects to /login if the cookie is missing, invalid, or unauthorized.
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

    if (decoded['provider'] !== true) {
      console.error('[operator-dal] session_missing_provider_claim')
      redirect('/login')
    }

    const email = decoded.email ?? ''

    if (!OPERATOR_ALLOWLIST.includes(email)) {
      console.error('[operator-dal] session_email_not_in_allowlist')
      redirect('/login')
    }

    return {
      uid: decoded.uid,
      email,
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
