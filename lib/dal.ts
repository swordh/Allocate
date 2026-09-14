import 'server-only'

import { cache } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { adminAuth, adminDb } from '@/lib/firebase-admin'
import type { SessionClaims } from '@/types'

/** A verified session that may or may not have an active company. */
export interface AuthenticatedSession {
  uid: string
  email: string
  activeCompanyId?: string
  role?: SessionClaims['role']
}

/**
 * Fetches `companies/{companyId}`, deduped per request via React's `cache()`.
 *
 * Exists so `getVerifiedSession`'s existence check below and any Server
 * Component that needs the same document in the same request/render (e.g.
 * `app/(app)/layout.tsx`, `app/subscribe/page.tsx`) share ONE Firestore read
 * instead of each doing their own — `cache()` dedupes by the identity of
 * this exact function plus its argument within one render pass, same
 * mechanism `getVerifiedSession` itself already relies on.
 */
export const getCompanyDoc = cache(
  (companyId: string) => adminDb.doc(`companies/${companyId}`).get(),
)

/**
 * Verifies the __session cookie and returns the decoded claims, WITHOUT
 * requiring an `activeCompanyId` claim to be present. Redirects to /login if
 * the cookie is missing or invalid, or to /verify-email if the email isn't
 * verified yet.
 *
 * This is the shared base both `getVerifiedSession` (below, for the normal
 * case: an active company is required) and `getSessionWithoutCompany`
 * (lib/queries — used by the one route that must work WITHOUT a company,
 * `/no-company`) build on. Wrapped in React.cache — multiple Server
 * Components calling either wrapper in the same render pass incur only one
 * Admin SDK verification call.
 */
export const verifyAuthenticatedSession = cache(async (): Promise<AuthenticatedSession> => {
  const cookieStore = await cookies()
  const sessionCookie = cookieStore.get('__session')?.value

  if (!sessionCookie) {
    console.error('[dal] session_cookie_missing')
    redirect('/login')
  }

  try {
    const decoded = await adminAuth.verifySessionCookie(sessionCookie, true)

    // Checked before the company claim: an unverified user should land on
    // /verify-email regardless of whether she has a company yet — that's
    // true for both signup flows (setupNewCompany/acceptInvitationByToken
    // already ran and set the company claim by the time createSession is
    // called, so this reordering doesn't change their behaviour) and for a
    // stranded, unverified account, which shouldn't be routed to
    // /no-company ahead of finishing verification.
    if (decoded['email_verified'] === false) {
      console.error('[dal] session_email_unverified')
      redirect('/verify-email')
    }

    return {
      uid:             decoded.uid,
      email:           decoded.email ?? '',
      activeCompanyId: decoded['activeCompanyId'] as string | undefined,
      role:            decoded['role'] as SessionClaims['role'] | undefined,
    }
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

/**
 * Verifies the __session cookie and returns the decoded claims. Redirects to
 * /login if the cookie is missing or invalid, to /verify-email if the email
 * isn't verified, and to /no-company if the session has no `activeCompanyId`
 * claim at all (issue #252 step 5, PR F — previously this redirected to
 * /login, which bounced a company-less user between /login and /bookings
 * forever: signing in re-issues a valid session cookie, but one that still
 * carries no company claim).
 *
 * Also verifies the company the claim points at still exists. Server
 * Actions and Server Components use the Admin SDK, which bypasses Firestore
 * Security Rules entirely — unlike a client-side listener, nothing here
 * stops a stale `activeCompanyId` from being read/written against a company
 * that no longer exists. Before the #252 step 5 purge (PR E) shipped, a
 * company could only disappear through manual ops work; now it can
 * disappear as the ordinary result of a member using the product, so this
 * check earns its keep. It's placed in this single, already-cached
 * bottleneck — not duplicated per Server Action — and reads through
 * `getCompanyDoc` above so a Server Component that needs the same document
 * right after (e.g. `app/(app)/layout.tsx` for subscription status) doesn't
 * pay for a second read: within one request this costs at most one extra
 * read total, not one per caller.
 *
 * Wrapped in React.cache — multiple Server Components calling this in the
 * same render pass incur only one Admin SDK verification call.
 */
export const getVerifiedSession = cache(async (): Promise<SessionClaims> => {
  const session = await verifyAuthenticatedSession()

  if (!session.activeCompanyId) {
    console.error('[dal] session_missing_company_claim')
    redirect('/no-company')
  }

  const companySnap = await getCompanyDoc(session.activeCompanyId)
  if (!companySnap.exists) {
    console.error('[dal] session_company_not_found')
    redirect('/no-company')
  }

  const claims: SessionClaims = {
    uid:             session.uid,
    email:           session.email,
    activeCompanyId: session.activeCompanyId,
    role:            session.role as SessionClaims['role'],
  }

  return claims
})

/**
 * The counterpart to `getVerifiedSession` for the one route that must work
 * for a signed-in user WITHOUT a company: `/no-company` (issue #252 step 5,
 * PR F — see "Del 3" of the design brief). Redirects to /login or
 * /verify-email exactly like `getVerifiedSession`, but if the session
 * already has a working `activeCompanyId` (pointing at a company that still
 * exists), it redirects to /bookings instead of rendering — there is
 * nothing for her to do on this page once she has a place again.
 */
export const getSessionWithoutCompany = cache(async (): Promise<AuthenticatedSession> => {
  const session = await verifyAuthenticatedSession()

  if (session.activeCompanyId) {
    const companySnap = await getCompanyDoc(session.activeCompanyId)
    if (companySnap.exists) {
      redirect('/bookings')
    }
  }

  return session
})
