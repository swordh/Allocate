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
    console.log('[dal] No session cookie found — redirecting to /login')
    redirect('/login')
  }

  try {
    const decoded = await adminAuth.verifySessionCookie(sessionCookie, true)

    const claims: SessionClaims = {
      uid:             decoded.uid,
      email:           decoded.email ?? '',
      activeCompanyId: decoded['activeCompanyId'] as string,
      role:            decoded['role'] as SessionClaims['role'],
    }

    return claims
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[dal] Session cookie verification failed — redirecting to /login', { error: message })
    redirect('/login')
  }
})
