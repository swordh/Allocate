import { NextRequest, NextResponse } from 'next/server'

const PUBLIC_PATHS = ['/login', '/signup', '/api/auth/session']

/**
 * Auth guard for all application routes.
 * Runs in Edge Runtime — must stay lightweight (no Node.js APIs).
 *
 * This middleware performs a presence check only: if the __session cookie
 * is missing, redirect to /login. Full cryptographic verification of the
 * session cookie happens in the DAL (lib/dal.ts → getVerifiedSession),
 * which runs in the Node.js runtime inside Server Components and Server Actions.
 *
 * CRITICAL: Keep this fast. Never import firebase-admin here.
 * Role checks and company scoping happen in Server Components and Server Actions via the DAL.
 *
 * CRITICAL: Server Actions are NOT separate route entries — the matcher below
 * applies to the page that calls the action, not the action itself.
 * Always verify auth inside each Server Action independently via getVerifiedSession().
 */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Allow public routes and Next.js internals through without auth check.
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  const sessionCookie = req.cookies.get('__session')?.value

  if (!sessionCookie) {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  // Cookie is present — forward the pathname as a request header so Server
  // Components can read the current path without a client-side hook.
  // Full token verification happens in getVerifiedSession() (DAL, Node.js runtime).
  const requestHeaders = new Headers(req.headers)
  requestHeaders.set('x-pathname', pathname)
  return NextResponse.next({ request: { headers: requestHeaders } })
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.png$).*)'],
}
