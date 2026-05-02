import 'server-only'

import { cache } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { adminAuth } from '@/lib/firebase-admin'
import type { SessionClaims } from '@/types'

/**
 * Verifies the __session cookie and returns the decoded claims.
 * Redirects to /login if the cookie is missing or invalid.
 *
 * Wrapped in React.cache — multiple Server Components calling this in the
 * same render pass incur only one Admin SDK verification call.
 */
export const getVerifiedSession = cache(async (): Promise<SessionClaims> => {
  const cookieStore = await cookies()
  const sessionCookie = cookieStore.get('__session')?.value

  if (!sessionCookie) {
    console.error('[dal] session_cookie_missing')
    redirect('/login')
  }

  try {
    const decoded = await adminAuth.verifySessionCookie(sessionCookie, true)

    const activeCompanyId = decoded['activeCompanyId'] as string | undefined

    // If claims are missing the user completed Auth but not company setup —
    // send them back to login to restart the flow.
    if (!activeCompanyId) {
      console.error('[dal] session_missing_company_claim')
      redirect('/login')
    }

    if (decoded['email_verified'] === false) {
      console.error('[dal] session_email_unverified')
      redirect('/verify-email')
    }

    const claims: SessionClaims = {
      uid:             decoded.uid,
      email:           decoded.email ?? '',
      activeCompanyId,
      role:            decoded['role'] as SessionClaims['role'],
    }

    return claims
  } catch (err) {
    // Re-throw Next.js redirect errors so they propagate to the framework.
    // In production, redirect() throws an error with a NEXT_REDIRECT digest.
    // In test, the mock throws Error('REDIRECT:…'). Both must pass through.
    const digest = (err as { digest?: string }).digest ?? ''
    const msg    = err instanceof Error ? err.message : ''
    if (digest.startsWith('NEXT_REDIRECT') || msg.startsWith('REDIRECT:')) throw err
    // Do not log the raw error — Firebase session errors can contain tokens or emails.
    console.error('[dal] session_cookie_invalid')
    redirect('/login')
  }
})
