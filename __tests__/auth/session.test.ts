/**
 * Auth session unit tests.
 *
 * Covers:
 *   - getVerifiedSession (lib/dal.ts): redirects when cookie is missing,
 *     when the session cookie is invalid, and when activeCompanyId is absent
 *     from the decoded claims.
 *   - createSession (actions/auth.ts): throws when verifyIdToken rejects,
 *     and sets the __session cookie on a valid token.
 *   - switchCompany (actions/auth.ts): revokes refresh tokens after a
 *     successful switch; does NOT revoke when membership is missing.
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
  mockSetCustomUserClaims,
  mockRevokeRefreshTokens,
  mockMembershipGet,
  mockCookieGet,
  mockCookieSet,
  mockCookieDelete,
} = vi.hoisted(() => ({
  mockVerifySessionCookie:  vi.fn(),
  mockVerifyIdToken:        vi.fn(),
  mockCreateSessionCookie:  vi.fn(),
  mockSetCustomUserClaims:  vi.fn(),
  mockRevokeRefreshTokens:  vi.fn(),
  mockMembershipGet:        vi.fn(),
  mockCookieGet:            vi.fn(),
  mockCookieSet:            vi.fn(),
  mockCookieDelete:         vi.fn(),
}))

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/firebase-admin', () => {
  // Chainable Firestore stub: collection().doc().collection().doc().get()
  const membershipDocRef   = { get: mockMembershipGet }
  const membershipColRef   = { doc: vi.fn().mockReturnValue(membershipDocRef) }
  const userDocRef         = { collection: vi.fn().mockReturnValue(membershipColRef) }
  const usersCollectionRef = { doc: vi.fn().mockReturnValue(userDocRef) }

  return {
    adminAuth: {
      verifySessionCookie:  mockVerifySessionCookie,
      verifyIdToken:        mockVerifyIdToken,
      createSessionCookie:  mockCreateSessionCookie,
      setCustomUserClaims:  mockSetCustomUserClaims,
      revokeRefreshTokens:  mockRevokeRefreshTokens,
    },
    adminDb: {
      doc:        vi.fn(),
      collection: vi.fn().mockReturnValue(usersCollectionRef),
    },
  }
})

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
import { createSession, switchCompany } from '@/actions/auth'

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
      email_verified:  true,
    })

    // React.cache is a pass-through in tests (see __mocks__/next-cache.ts),
    // so every call hits the mock directly with no memoisation.
    const claims = await getVerifiedSession()

    expect(claims.uid).toBe('user-1')
    expect(claims.email).toBe('user@example.com')
    expect(claims.activeCompanyId).toBe('company-abc')
    expect(claims.role).toBe('admin')
  })

  // ── email_verified checks (issue #70) ─────────────────────────────────────

  it('redirects to /verify-email when email_verified is false', async () => {
    mockCookieGet.mockReturnValue({ value: 'unverified-session-token' })
    mockVerifySessionCookie.mockResolvedValue({
      uid:             'user-2',
      email:           'unverified@example.com',
      activeCompanyId: 'company-abc',
      role:            'admin',
      email_verified:  false,
    })

    await expect(getVerifiedSession()).rejects.toThrow('REDIRECT:/verify-email')
  })

  it('does NOT redirect to /login when email_verified is false (route is /verify-email)', async () => {
    mockCookieGet.mockReturnValue({ value: 'unverified-session-token' })
    mockVerifySessionCookie.mockResolvedValue({
      uid:             'user-2',
      email:           'unverified@example.com',
      activeCompanyId: 'company-abc',
      role:            'admin',
      email_verified:  false,
    })

    // The redirect must go to /verify-email, not /login — they are distinct
    // routes with different UI. Asserting the wrong target would silently pass.
    await expect(getVerifiedSession()).rejects.toThrow('REDIRECT:/verify-email')
    await expect(getVerifiedSession()).rejects.not.toThrow('REDIRECT:/login')
  })

  it('returns SessionClaims when email_verified is true', async () => {
    mockCookieGet.mockReturnValue({ value: 'verified-session-token' })
    mockVerifySessionCookie.mockResolvedValue({
      uid:             'user-3',
      email:           'verified@example.com',
      activeCompanyId: 'company-xyz',
      role:            'crew',
      email_verified:  true,
    })

    const claims = await getVerifiedSession()

    expect(claims.uid).toBe('user-3')
    expect(claims.email).toBe('verified@example.com')
    expect(claims.activeCompanyId).toBe('company-xyz')
    expect(claims.role).toBe('crew')
  })

  it('does not redirect to /verify-email when email_verified is undefined (legacy sessions)', async () => {
    // Defensive: existing sessions minted before issue #70 may not carry the
    // email_verified claim. They must continue to work — only an explicit
    // false should gate access.
    mockCookieGet.mockReturnValue({ value: 'legacy-session-token' })
    mockVerifySessionCookie.mockResolvedValue({
      uid:             'user-4',
      email:           'legacy@example.com',
      activeCompanyId: 'company-legacy',
      role:            'admin',
      // email_verified intentionally absent
    })

    const claims = await getVerifiedSession()

    expect(claims.uid).toBe('user-4')
    expect(claims.activeCompanyId).toBe('company-legacy')
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

// ── Tests: switchCompany ──────────────────────────────────────────────────────
//
// switchCompany sets new custom claims and revokes all refresh tokens so that
// any outstanding session cookie carrying the old activeCompanyId is immediately
// invalidated (issue #103).

describe('switchCompany', () => {
  // Wire getVerifiedSession to return a valid session by default.
  const VALID_SESSION_COOKIE = 'valid-switch-session-token'

  beforeEach(() => {
    vi.clearAllMocks()

    mockCookieGet.mockReturnValue({ value: VALID_SESSION_COOKIE })
    mockVerifySessionCookie.mockResolvedValue({
      uid:             'user-switch',
      email:           'switch@example.com',
      activeCompanyId: 'company-old',
      role:            'admin',
      email_verified:  true,
    })

    mockSetCustomUserClaims.mockResolvedValue(undefined)
    mockRevokeRefreshTokens.mockResolvedValue(undefined)
  })

  it('calls revokeRefreshTokens with the correct uid after a successful company switch', async () => {
    mockMembershipGet.mockResolvedValue({
      exists: true,
      data:   () => ({ role: 'admin' }),
    })

    await switchCompany('company-new')

    expect(mockSetCustomUserClaims).toHaveBeenCalledWith('user-switch', {
      activeCompanyId: 'company-new',
      role:            'admin',
    })
    expect(mockRevokeRefreshTokens).toHaveBeenCalledOnce()
    expect(mockRevokeRefreshTokens).toHaveBeenCalledWith('user-switch')
  })

  it('does NOT call revokeRefreshTokens when the membership document does not exist', async () => {
    mockMembershipGet.mockResolvedValue({
      exists: false,
      data:   () => undefined,
    })

    await expect(switchCompany('company-nonexistent')).rejects.toThrow('Failed to switch company')

    expect(mockRevokeRefreshTokens).not.toHaveBeenCalled()
  })
})
