import { NextRequest, NextResponse } from 'next/server'
import { adminAuth } from '@/lib/firebase-admin'

const PUBLIC_PATHS = ['/login', '/signup', '/api/auth/session']

/**
 * Auth guard for all application routes.
 * Verifies the __session cookie on every request.
 * Redirects to /login if the cookie is absent or invalid.
 *
 * CRITICAL: Keep this fast. Never query Firestore here.
 * Role checks and company scoping happen in Server Components and Server Actions via the DAL.
 *
 * CRITICAL: Server Actions are NOT separate route entries — the matcher below
 * applies to the page that calls the action, not the action itself.
 * Always verify auth inside each Server Action independently via getVerifiedSession().
 */
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Allow public routes and Next.js internals through without auth check.
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  const sessionCookie = req.cookies.get('__session')?.value

  if (!sessionCookie) {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  try {
    // Optimistic check — verifies the cookie signature and expiry only.
    // Does not hit Firestore.
    await adminAuth.verifySessionCookie(sessionCookie, true)
    return NextResponse.next()
  } catch {
    const response = NextResponse.redirect(new URL('/login', req.url))
    response.cookies.delete('__session')
    return response
  }
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.png$).*)'],
}
