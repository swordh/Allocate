/**
 * Issue #350 (GDPR) — proves `app/(app)/layout.tsx` actually CALLS
 * `evaluateAppAccess` (lib/subscriptionAccess.ts), not just that the helper
 * itself is correct. `__tests__/lib/subscriptionAccess.test.ts` already
 * covers the helper in isolation; a perfect helper is worthless if the
 * layout stops calling it, which is exactly the class of regression a
 * pure-function unit test cannot catch. See step 8d.6 of the plan — removing
 * the `evaluateAppAccess` call from the layout should fail ONLY this file.
 *
 * `app/(app)/layout.tsx` is an async Server Component. Calling it directly
 * as a function runs its body (the part under test) and returns a React
 * element tree; `React.createElement` never invokes the child components
 * (PrimaryNav, MobileMenu, etc.) it references, so nothing here needs to
 * mock them — only the data layer the layout itself calls: `@/lib/dal`,
 * `@/lib/queries/users`, `@/lib/queries/companies`, and `headers()`
 * (`next/headers`'s mock is wired globally in vitest.config.ts; `redirect()`
 * throws `Error('REDIRECT:<url>')` via the same global mock).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { headers } from 'next/headers'

const { mockGetVerifiedSession, mockGetCompanyDoc, mockGetUserProfile, mockListUserCompanies } = vi.hoisted(() => ({
  mockGetVerifiedSession: vi.fn(),
  mockGetCompanyDoc: vi.fn(),
  mockGetUserProfile: vi.fn(),
  mockListUserCompanies: vi.fn(),
}))

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: mockGetVerifiedSession,
  getCompanyDoc: mockGetCompanyDoc,
}))

vi.mock('@/lib/queries/users', () => ({
  getUserProfile: mockGetUserProfile,
}))

vi.mock('@/lib/queries/companies', () => ({
  listUserCompanies: mockListUserCompanies,
}))

// The layout module references MobileMenu/PrimaryNav in JSX, which is never
// executed by React.createElement, but importing the layout module still
// eagerly runs every module in that import graph's top-level code —
// including lib/useCompanySwitch.ts -> lib/firebase.ts, which calls
// getAuth() at import time and throws without real
// NEXT_PUBLIC_FIREBASE_* env vars. Stubbed out here; nothing under test
// touches client Firebase.
vi.mock('@/lib/firebase', () => ({ auth: {}, db: {} }))

import AppLayout from '@/app/(app)/layout'

const SESSION = {
  uid: 'user-1',
  email: 'anna@example.com',
  activeCompanyId: 'company-A',
  role: 'admin' as const,
}

function wire(opts: { pathname: string | null; role?: 'admin' | 'crew' | 'viewer'; companyData?: Record<string, unknown> }) {
  mockGetVerifiedSession.mockResolvedValue({ ...SESSION, role: opts.role ?? SESSION.role })
  mockGetCompanyDoc.mockResolvedValue({
    data: () => ({ name: 'Rigg & Rep AB', ...(opts.companyData ?? {}) }),
  })
  mockGetUserProfile.mockResolvedValue({ name: 'Anna' })
  mockListUserCompanies.mockResolvedValue([])
  vi.mocked(headers).mockResolvedValue({
    get: (key: string) => (key === 'x-pathname' ? opts.pathname : null),
  } as unknown as Awaited<ReturnType<typeof headers>>)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AppLayout — evaluateAppAccess is actually wired in', () => {
  it('does NOT redirect a company with no subscription field, on /settings/account', async () => {
    wire({ pathname: '/settings/account', companyData: {} })
    await expect(AppLayout({ children: null })).resolves.toBeTruthy()
  })

  it('DOES redirect a company with no subscription field, on a non-always-available route, to /subscribe (admin)', async () => {
    wire({ pathname: '/bookings', role: 'admin', companyData: {} })
    await expect(AppLayout({ children: null })).rejects.toThrow('REDIRECT:/subscribe')
  })

  it('DOES redirect a company with no subscription field, on a non-always-available route, to /settings/account (crew)', async () => {
    wire({ pathname: '/bookings', role: 'crew', companyData: {} })
    await expect(AppLayout({ children: null })).rejects.toThrow('REDIRECT:/settings/account')
  })

  it('does not redirect a company with an active subscription, regardless of pathname', async () => {
    wire({ pathname: '/bookings', companyData: { subscription: { status: 'active' } } })
    await expect(AppLayout({ children: null })).resolves.toBeTruthy()
  })
})
