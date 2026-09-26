/**
 * Unit tests for lib/operator-dal.ts (issue #344).
 *
 * Covers getOperatorSession's Firestore-backed gate:
 *   - operators/{uid} exists → returns the session
 *   - operators/{uid} missing → redirects to /login
 *   - the Firestore read itself throws → redirects to /login (fail closed —
 *     a read error must never be treated as "presumed operator")
 *   - missing or invalid session cookie → redirects to /login
 *
 * Firebase Admin and Next.js cookies/redirect are fully mocked, same
 * pattern as __tests__/auth/session.test.ts. All spies are created via
 * vi.hoisted() so they are available inside vi.mock() factory callbacks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockVerifySessionCookie, mockOperatorDocGet, mockCookieGet } = vi.hoisted(() => ({
  mockVerifySessionCookie: vi.fn(),
  mockOperatorDocGet:      vi.fn(),
  mockCookieGet:           vi.fn(),
}))

vi.mock('@/lib/firebase-admin', () => {
  const operatorDocRef = { get: mockOperatorDocGet }
  const operatorsColRef = { doc: vi.fn().mockReturnValue(operatorDocRef) }

  return {
    adminAuth: {
      verifySessionCookie: mockVerifySessionCookie,
    },
    adminDb: {
      collection: vi.fn().mockReturnValue(operatorsColRef),
    },
  }
})

vi.mock('next/headers', () => {
  const store = { get: mockCookieGet }
  return { cookies: vi.fn().mockResolvedValue(store) }
})

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string): never => {
    throw new Error(`REDIRECT:${url}`)
  }),
}))

import { getOperatorSession, isOperator } from '@/lib/operator-dal'

describe('isOperator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns true when operators/{uid} exists', async () => {
    mockOperatorDocGet.mockResolvedValue({ exists: true })

    await expect(isOperator('uid-1')).resolves.toBe(true)
  })

  it('returns false when operators/{uid} is missing', async () => {
    mockOperatorDocGet.mockResolvedValue({ exists: false })

    await expect(isOperator('uid-2')).resolves.toBe(false)
  })

  it('fails closed: returns false and logs when the Firestore read throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockOperatorDocGet.mockRejectedValue(new Error('boom'))

    await expect(isOperator('uid-3')).resolves.toBe(false)
    expect(errorSpy).toHaveBeenCalled()
  })
})

describe('getOperatorSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the session when the cookie is valid and operators/{uid} exists', async () => {
    mockCookieGet.mockReturnValue({ value: 'valid-session-token' })
    mockVerifySessionCookie.mockResolvedValue({ uid: 'operator-1', email: 'jocke@allocate.at' })
    mockOperatorDocGet.mockResolvedValue({ exists: true })

    const session = await getOperatorSession()

    expect(session.uid).toBe('operator-1')
    expect(session.email).toBe('jocke@allocate.at')
  })

  it('redirects to /login when the __session cookie is missing', async () => {
    mockCookieGet.mockReturnValue(undefined)

    await expect(getOperatorSession()).rejects.toThrow('REDIRECT:/login')
  })

  it('redirects to /login when the session cookie is invalid', async () => {
    mockCookieGet.mockReturnValue({ value: 'bad-token' })
    mockVerifySessionCookie.mockRejectedValue(new Error('auth/invalid-session-cookie'))

    await expect(getOperatorSession()).rejects.toThrow('REDIRECT:/login')
  })

  it('redirects to /login when operators/{uid} does not exist', async () => {
    mockCookieGet.mockReturnValue({ value: 'valid-session-token' })
    mockVerifySessionCookie.mockResolvedValue({ uid: 'not-an-operator', email: 'stranger@example.com' })
    mockOperatorDocGet.mockResolvedValue({ exists: false })

    await expect(getOperatorSession()).rejects.toThrow('REDIRECT:/login')
  })

  // Fail-closed guard, exercised through the full session path: a Firestore
  // error while checking operator status must redirect exactly like a
  // missing doc would, never grant a session.
  it('redirects to /login when the Firestore operator check throws', async () => {
    mockCookieGet.mockReturnValue({ value: 'valid-session-token' })
    mockVerifySessionCookie.mockResolvedValue({ uid: 'operator-1', email: 'jocke@allocate.at' })
    mockOperatorDocGet.mockRejectedValue(new Error('Firestore unavailable'))

    await expect(getOperatorSession()).rejects.toThrow('REDIRECT:/login')
  })
})
