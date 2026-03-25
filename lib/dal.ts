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

    const claims: SessionClaims = {
      uid:             decoded.uid,
      email:           decoded.email ?? '',
      activeCompanyId,
      role:            decoded['role'] as SessionClaims['role'],
    }

    return claims
  } catch {
    // Do not log the raw error — Firebase session errors can contain tokens or emails.
    console.error('[dal] session_cookie_invalid')
    redirect('/login')
  }
})
