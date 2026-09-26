/**
 * Unit tests for actions/operator-auth.ts → operatorSignIn (issue #344).
 *
 * Covers:
 *   - operator → __session cookie is set, and a 'granted' row is written to
 *     operatorLoginLog with expireAt ≈ now + 365 days and the right
 *     outcome/reason.
 *   - non-operator → { ok: false }, a 'denied' row is written, no cookie.
 *   - invalid token → { ok: false }, no Firestore log at all (no identity).
 *   - the 'granted' log write fails → { ok: false }, no cookie ("no access
 *     without an audit trail").
 *   - the 'denied' log write fails → still { ok: false }, and the failure is
 *     swallowed (never throws).
 *
 * isOperator (lib/operator-dal.ts) and writeOperatorLoginLog
 * (lib/operator-login-log.ts) both go through '@/lib/firebase-admin', which
 * is the single mock boundary here — so both run as real code against a
 * fake Firestore, the same style __tests__/auth/session.test.ts uses for
 * getVerifiedSession/createSession/switchCompany.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockVerifyIdToken,
  mockCreateSessionCookie,
  mockOperatorDocGet,
  mockOperatorLoginLogAdd,
  mockCookieSet,
} = vi.hoisted(() => ({
  mockVerifyIdToken:       vi.fn(),
  mockCreateSessionCookie: vi.fn(),
  mockOperatorDocGet:      vi.fn(),
  mockOperatorLoginLogAdd: vi.fn(),
  mockCookieSet:           vi.fn(),
}))

vi.mock('@/lib/firebase-admin', () => {
  const operatorDocRef = { get: mockOperatorDocGet }
  const operatorsColRef = { doc: vi.fn().mockReturnValue(operatorDocRef) }
  const operatorLoginLogColRef = { add: mockOperatorLoginLogAdd }

  return {
    adminAuth: {
      verifyIdToken:       mockVerifyIdToken,
      createSessionCookie: mockCreateSessionCookie,
    },
    adminDb: {
      collection: vi.fn((name: string) => {
        if (name === 'operators') return operatorsColRef
        if (name === 'operatorLoginLog') return operatorLoginLogColRef
        throw new Error(`unexpected collection: ${name}`)
      }),
    },
  }
})

vi.mock('next/headers', () => {
  const store = { set: mockCookieSet }
  return { cookies: vi.fn().mockResolvedValue(store) }
})

import { operatorSignIn } from '@/actions/operator-auth'

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000

describe('operatorSignIn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOperatorLoginLogAdd.mockResolvedValue({ id: 'log-doc-id' })
    mockCookieSet.mockResolvedValue(undefined)
  })

  it('sets the cookie and writes a granted log for an operator', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'operator-1', email: 'jocke@allocate.at' })
    mockOperatorDocGet.mockResolvedValue({ exists: true })
    mockCreateSessionCookie.mockResolvedValue('session-cookie-value')

    const before = Date.now()
    const result = await operatorSignIn('valid-id-token')
    const after = Date.now()

    expect(result).toEqual({ ok: true })
    expect(mockCookieSet).toHaveBeenCalledWith('__session', 'session-cookie-value', expect.objectContaining({ httpOnly: true }))

    expect(mockOperatorLoginLogAdd).toHaveBeenCalledTimes(1)
    const written = mockOperatorLoginLogAdd.mock.calls[0][0]
    expect(written.uid).toBe('operator-1')
    expect(written.email).toBe('jocke@allocate.at')
    expect(written.outcome).toBe('granted')
    expect(typeof written.reason).toBe('string')

    const expireAtMs = written.expireAt.toMillis()
    expect(expireAtMs).toBeGreaterThanOrEqual(before + ONE_YEAR_MS - 5000)
    expect(expireAtMs).toBeLessThanOrEqual(after + ONE_YEAR_MS + 5000)
  })

  it('writes the granted log BEFORE the cookie is set', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'operator-1', email: 'jocke@allocate.at' })
    mockOperatorDocGet.mockResolvedValue({ exists: true })
    mockCreateSessionCookie.mockResolvedValue('session-cookie-value')

    const order: string[] = []
    mockOperatorLoginLogAdd.mockImplementation(async () => {
      order.push('log')
      return { id: 'log-doc-id' }
    })
    mockCookieSet.mockImplementation(async () => {
      order.push('cookie')
    })

    await operatorSignIn('valid-id-token')

    expect(order).toEqual(['log', 'cookie'])
  })

  it('returns { ok: false } and writes a denied log for a non-operator, with no cookie', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'stranger-1', email: 'stranger@example.com' })
    mockOperatorDocGet.mockResolvedValue({ exists: false })

    const result = await operatorSignIn('valid-id-token')

    expect(result).toEqual({ ok: false })
    expect(mockCookieSet).not.toHaveBeenCalled()

    expect(mockOperatorLoginLogAdd).toHaveBeenCalledTimes(1)
    const written = mockOperatorLoginLogAdd.mock.calls[0][0]
    expect(written.uid).toBe('stranger-1')
    expect(written.email).toBe('stranger@example.com')
    expect(written.outcome).toBe('denied')
    expect(written.reason).toBe('not_operator')
  })

  it('returns { ok: false } and writes no Firestore log for an invalid token', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('auth/argument-error'))

    const result = await operatorSignIn('bad-id-token')

    expect(result).toEqual({ ok: false })
    expect(mockOperatorLoginLogAdd).not.toHaveBeenCalled()
    expect(mockCookieSet).not.toHaveBeenCalled()
    // No identity was ever decoded, so the operator check itself must never run.
    expect(mockOperatorDocGet).not.toHaveBeenCalled()
  })

  it('denies the login and sets no cookie when the granted log write fails', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'operator-1', email: 'jocke@allocate.at' })
    mockOperatorDocGet.mockResolvedValue({ exists: true })
    mockCreateSessionCookie.mockResolvedValue('session-cookie-value')
    mockOperatorLoginLogAdd.mockRejectedValue(new Error('Firestore unavailable'))

    const result = await operatorSignIn('valid-id-token')

    expect(result).toEqual({ ok: false })
    expect(mockCookieSet).not.toHaveBeenCalled()
  })

  it('still returns { ok: false } without throwing when the denied log write fails', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'stranger-1', email: 'stranger@example.com' })
    mockOperatorDocGet.mockResolvedValue({ exists: false })
    mockOperatorLoginLogAdd.mockRejectedValue(new Error('Firestore unavailable'))

    await expect(operatorSignIn('valid-id-token')).resolves.toEqual({ ok: false })
    expect(mockCookieSet).not.toHaveBeenCalled()
  })
})
