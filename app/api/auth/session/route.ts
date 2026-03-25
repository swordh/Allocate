import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { adminAuth } from '@/lib/firebase-admin'

// 14 days in milliseconds — matches the Firebase session cookie maximum.
const SESSION_DURATION_MS = 60 * 60 * 24 * 14 * 1000

export async function POST(request: NextRequest) {
  let uid: string | undefined

  try {
    const body = await request.json() as { idToken?: unknown }
    const idToken = body.idToken

    if (typeof idToken !== 'string' || !idToken) {
      return NextResponse.json({ error: 'idToken is required' }, { status: 400 })
    }

    // Verify the ID token and extract the uid before creating the session cookie.
    const decodedToken = await adminAuth.verifyIdToken(idToken)
    uid = decodedToken.uid

    const sessionCookie = await adminAuth.createSessionCookie(idToken, {
      expiresIn: SESSION_DURATION_MS,
    })

    const cookieStore = await cookies()
    cookieStore.set('__session', sessionCookie, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path:     '/',
      maxAge:   60 * 60 * 24 * 14, // 14 days in seconds
    })

    console.log('[auth/session]', { uid, action: 'session_created' })

    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[auth/session]', { error: message, uid: uid ?? 'unknown' })
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
