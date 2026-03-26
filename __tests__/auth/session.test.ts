/**
 * Auth session unit tests.
 *
 * Covers:
 *   - getVerifiedSession (lib/dal.ts): redirects when cookie is missing,
 *     when the session cookie is invalid, and when activeCompanyId is absent
 *     from the decoded claims.
 *   - createSession (actions/auth.ts): throws when verifyIdToken rejects,
 *     and sets the __session cookie on a valid token.
 *
 * Firebase Admin and Next.js cookies/redirect are fully mocked.
 * All spies are created via vi.hoisted() so they are available inside
 * vi.mock() factory callbacks (which are hoisted to the top of the file).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted spies (available inside vi.mock factories) ────────────────────────

const {
  mockVerifySessionCookie,
  mockVerifyIdToken,
  mockCreateSessionCookie,
  mockCookieGet,
  mockCookieSet,
  mockCookieDelete,
} = vi.hoisted(() => ({
  mockVerifySessionCookie:  vi.fn(),
  mockVerifyIdToken:        vi.fn(),
  mockCreateSessionCookie:  vi.fn(),
  mockCookieGet:            vi.fn(),
  mockCookieSet:            vi.fn(),
  mockCookieDelete:         vi.fn(),
}))

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/firebase-admin', () => ({
  adminAuth: {
    verifySessionCookie: mockVerifySessionCookie,
    verifyIdToken:       mockVerifyIdToken,
    createSessionCookie: mockCreateSessionCookie,
  },
  adminDb: {
    doc:        vi.fn(),
    collection: vi.fn(),
  },
}))

vi.mock('next/headers', () => {
  const store = {
    get:    mockCookieGet,
    set:    mockCookieSet,
    delete: mockCookieDelete,
  }
  return { cookies: vi.fn().mockResolvedValue(store) }
})

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string): never => {
    throw new Error(`REDIRECT:${url}`)
  }),
}))

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { getVerifiedSession } from '@/lib/dal'
import { createSession } from '@/actions/auth'

// ── Tests: getVerifiedSession ─────────────────────────────────────────────────
//
// This is the authoritative auth guard for all Server Actions and Server
// Components. It verifies the __session cookie and checks that the decoded
// token carries the activeCompanyId claim.

describe('getVerifiedSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('redirects to /login when the __session cookie is missing', async () => {
    mockCookieGet.mockReturnValue(undefined)

    await expect(getVerifiedSession()).rejects.toThrow('REDIRECT:/login')
  })

  it('redirects to /login when the session cookie is invalid', async () => {
    mockCookieGet.mockReturnValue({ value: 'bad-token' })
    mockVerifySessionCookie.mockRejectedValue(new Error('auth/invalid-session-cookie'))

    await expect(getVerifiedSession()).rejects.toThrow('REDIRECT:/login')
  })

  it('redirects to /login when activeCompanyId is absent from the decoded token', async () => {
    mockCookieGet.mockReturnValue({ value: 'valid-session-token' })
    mockVerifySessionCookie.mockResolvedValue({
      uid:   'user-1',
      email: 'user@example.com',
      // activeCompanyId intentionally absent — catches the signup→setup race
      role:  'admin',
    })

    await expect(getVerifiedSession()).rejects.toThrow('REDIRECT:/login')
  })

  it('redirects to /login when activeCompanyId is an empty string', async () => {
    mockCookieGet.mockReturnValue({ value: 'valid-session-token' })
    mockVerifySessionCookie.mockResolvedValue({
      uid:             'user-1',
      email:           'user@example.com',
      activeCompanyId: '', // empty — treated as missing
      role:            'admin',
    })

    await expect(getVerifiedSession()).rejects.toThrow('REDIRECT:/login')
  })

  it('returns SessionClaims when cookie is valid and all required claims are present', async () => {
    mockCookieGet.mockReturnValue({ value: 'good-session-token' })
    mockVerifySessionCookie.mockResolvedValue({
      uid:             'user-1',
      email:           'user@example.com',
      activeCompanyId: 'company-abc',
      role:            'admin',
    })

    // React.cache memoises the first resolved value per module lifetime.
    // Earlier tests all threw (rejected), so no resolved value is cached yet.
    // This call populates the cache and returns the claims.
    const claims = await getVerifiedSession()

    expect(claims.uid).toBe('user-1')
    expect(claims.email).toBe('user@example.com')
    expect(claims.activeCompanyId).toBe('company-abc')
    expect(claims.role).toBe('admin')
  })
})

// ── Tests: createSession ──────────────────────────────────────────────────────
//
// createSession verifies an ID token and issues a __session cookie.
// It delegates claims-presence enforcement to getVerifiedSession (dal.ts).
// Its only failure mode is an invalid/expired ID token or a Firebase error.

describe('createSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCookieSet.mockResolvedValue(undefined)
  })

  it('throws when the ID token is invalid (verifyIdToken rejects)', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('auth/argument-error'))

    await expect(createSession('bad-id-token')).rejects.toThrow('Failed to create session')
  })

  it('throws when createSessionCookie fails after a valid token', async () => {
    mockVerifyIdToken.mockResolvedValue({
      uid:             'user-1',
      email:           'user@example.com',
      activeCompanyId: 'company-abc',
    })
    mockCreateSessionCookie.mockRejectedValue(new Error('Firebase error'))

    await expect(createSession('valid-id-token')).rejects.toThrow('Failed to create session')
    expect(mockCookieSet).not.toHaveBeenCalled()
  })

  it('sets the __session cookie when the token is valid', async () => {
    mockVerifyIdToken.mockResolvedValue({
      uid:             'user-1',
      email:           'user@example.com',
      activeCompanyId: 'company-abc',
      role:            'admin',
    })
    mockCreateSessionCookie.mockResolvedValue('session-cookie-value')

    await createSession('valid-id-token')

    expect(mockCreateSessionCookie).toHaveBeenCalledWith(
      'valid-id-token',
      expect.objectContaining({ expiresIn: expect.any(Number) }),
    )
    expect(mockCookieSet).toHaveBeenCalledWith(
      '__session',
      'session-cookie-value',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        path:     '/',
      }),
    )
  })

  it('sets an httpOnly secure cookie in production', async () => {
    // Override process.env.NODE_ENV via the environment variable map.
    // NODE_ENV is read-only in some runtimes; use vi.stubEnv instead.
    vi.stubEnv('NODE_ENV', 'production')

    mockVerifyIdToken.mockResolvedValue({
      uid:             'user-1',
      email:           'user@example.com',
      activeCompanyId: 'company-abc',
    })
    mockCreateSessionCookie.mockResolvedValue('prod-cookie')

    await createSession('valid-id-token')

    const cookieOptions = mockCookieSet.mock.calls[0][2] as Record<string, unknown>
    expect(cookieOptions.secure).toBe(true)

    vi.unstubAllEnvs()
  })

  it('sets a non-secure cookie outside production', async () => {
    // NODE_ENV is 'test' in Vitest by default.
    mockVerifyIdToken.mockResolvedValue({
      uid:             'user-1',
      email:           'user@example.com',
      activeCompanyId: 'company-abc',
    })
    mockCreateSessionCookie.mockResolvedValue('dev-cookie')

    await createSession('valid-id-token')

    const cookieOptions = mockCookieSet.mock.calls[0][2] as Record<string, unknown>
    expect(cookieOptions.secure).toBe(false)
  })
})
