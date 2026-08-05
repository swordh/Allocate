/**
 * deleteAccount — multi-company sole-admin guard (issue #90)
 *
 * The guard iterates ALL of the user's memberships (via
 * `users/{uid}/memberships`), and for each membership where role === 'admin'
 * runs a collectionGroup count against `memberships` filtered by companyId and
 * role === 'admin'. If any company has count <= 1, deletion is blocked —
 * otherwise deleting the account would orphan a company with no admin.
 *
 * The guard now ships (commit ebe8043). The contract it must hold to:
 *
 *   - Block deletion when the user is the sole admin of ANY company they belong to.
 *   - Allow deletion when every company they are admin of has at least one other admin.
 *   - Allow deletion when the user has no memberships at all.
 *   - Allow deletion when the user is crew (not admin) in every company they belong to.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted spies ─────────────────────────────────────────────────────────────
//
// vi.hoisted() guarantees these references exist before vi.mock() factories run
// (factories are hoisted to the top of the file by Vitest).

const {
  mockVerifySessionCookie,
  mockCookieGet,
  mockCookieDelete,
  mockDeleteUser,
  mockDeleteSession,
  mockMembershipsGet,       // adminDb.collection('users/{uid}/memberships').get()
  mockCollectionGroupGet,   // collectionGroup('memberships') admin count
  mockUnitsGroupGet,        // collectionGroup('units') during anonymisation
  mockBatchCommit,
  mockBatchDelete,
} = vi.hoisted(() => ({
  mockVerifySessionCookie:  vi.fn(),
  mockCookieGet:            vi.fn(),
  mockCookieDelete:         vi.fn(),
  mockDeleteUser:           vi.fn(),
  mockDeleteSession:        vi.fn(),
  mockMembershipsGet:       vi.fn(),
  mockCollectionGroupGet:   vi.fn(),
  mockUnitsGroupGet:        vi.fn(),
  mockBatchCommit:          vi.fn(),
  mockBatchDelete:          vi.fn(),
}))

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'server-timestamp' },
}))

vi.mock('@/lib/firebase-admin', () => {
  // collectionGroup is used for two different things, and they must not share a
  // spy: 'memberships' counts admins during the guard, 'units' reads unit docs
  // during anonymisation. Routing them together made the units read return a
  // count snapshot with no .docs — and made the guard's "no count queries were
  // issued" assertions impossible to trust.
  const collectionGroupMock = vi.fn((groupId: string) => {
    let companyId: string | undefined
    const chain: Record<string, unknown> = {}
    chain['where'] = (field: string, _op: string, value: unknown) => {
      if (field === 'companyId') companyId = value as string
      return chain
    }
    chain['get'] = () =>
      groupId === 'units' ? mockUnitsGroupGet({ companyId }) : mockCollectionGroupGet({ companyId })
    chain['count'] = () => ({ get: () => mockCollectionGroupGet({ companyId }) })
    return chain
  })

  // A collection reference is both a query root and a doc factory. Production
  // reads memberships by slash path — adminDb.collection(`users/${uid}/memberships`)
  // — so .get() must live directly on the collection, not only on a nested one.
  const emptyChain: Record<string, unknown> = {}
  emptyChain['where'] = () => emptyChain
  emptyChain['get'] = async () => ({ docs: [] })

  const collectionMock = vi.fn((path: string) => ({
    path,
    doc: (id?: string) => makeRef(id ? `${path}/${id}` : `${path}/auto-id`),
    where: emptyChain['where'],
    get: path.endsWith('/memberships')
      ? mockMembershipsGet
      : (emptyChain['get'] as () => Promise<{ docs: [] }>),
  }))

  function makeRef(path: string) {
    return {
      path,
      id: path.split('/').pop(),
      // Company docs must exist and be readable. No createdBy match and no
      // stripeCustomerId, so anonymisation skips both the company update and
      // the Stripe call — keeping @/lib/stripe out of these tests entirely.
      get: async () => ({ exists: true, id: path.split('/').pop(), data: () => ({}) }),
    }
  }

  const docMock = vi.fn((path: string) => makeRef(path))

  const batchMock = vi.fn(() => ({
    set:    vi.fn(),
    update: vi.fn(),
    delete: mockBatchDelete,
    commit: mockBatchCommit,
  }))

  return {
    adminAuth: {
      verifySessionCookie: mockVerifySessionCookie,
      deleteUser:          mockDeleteUser,
    },
    adminDb: {
      collection:      collectionMock,
      collectionGroup: collectionGroupMock,
      doc:             docMock,
      batch:           batchMock,
    },
  }
})

vi.mock('next/headers', () => {
  const store = {
    get:    mockCookieGet,
    set:    vi.fn(),
    delete: mockCookieDelete,
  }
  return { cookies: vi.fn().mockResolvedValue(store) }
})

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string): never => {
    throw new Error(`REDIRECT:${url}`)
  }),
}))

// deleteSession is a Server Action in actions/auth.ts — mock the whole module
// so the test does not have to set up cookie infrastructure for it.
vi.mock('@/actions/auth', () => ({
  deleteSession: mockDeleteSession,
}))

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { deleteAccount } from '@/actions/account'

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Stub getVerifiedSession by controlling what verifySessionCookie returns.
 * The test session always carries uid='user-1' and activeCompanyId='company-A'.
 */
function stubSession(overrides?: Partial<{ uid: string; activeCompanyId: string }>) {
  mockCookieGet.mockReturnValue({ value: 'valid-session-token' })
  mockVerifySessionCookie.mockResolvedValue({
    uid:             overrides?.uid             ?? 'user-1',
    email:           'user@example.com',
    activeCompanyId: overrides?.activeCompanyId ?? 'company-A',
    role:            'admin',
    email_verified:  true,
  })
}

/**
 * Build a fake memberships snapshot — the result of
 * `adminDb.collection('users').doc(uid).collection('memberships').get()`.
 *
 * Each membership doc must have at minimum { companyId, role }.
 */
function makeMembershipsSnap(memberships: Array<{ companyId: string; role: string }>) {
  return {
    docs: memberships.map((m, i) => ({
      id: `membership-${i}`,
      data: () => m,
      // deleteAccount does batch.delete(membershipDoc.ref) during anonymisation.
      ref: { path: `users/user-1/memberships/membership-${i}`, id: `membership-${i}` },
    })),
  }
}

/** Build a count snapshot as returned by `.count().get()`. */
function makeCountSnap(count: number) {
  return {
    size: count,
    data: () => ({ count }),
  }
}

/** The exact message the sole-admin guard returns. */
const SOLE_ADMIN_ERROR =
  'Cannot delete account: you are the only admin of one of your companies. Transfer ownership first.'

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('deleteAccount — multi-company sole-admin guard (#90)', () => {
  beforeEach(() => {
    // clearAllMocks resets call history without touching mock implementations —
    // this preserves the next/headers factory (cookies → store object).
    vi.clearAllMocks()

    // Explicitly reset mocks that use mockResolvedValueOnce queues.
    // clearAllMocks does NOT drain those queues; mockReset() does.
    // Without this, unconsumed once-values from a previous test leak forward.
    mockCollectionGroupGet.mockReset()
    mockMembershipsGet.mockReset()
    mockUnitsGroupGet.mockReset()

    // Re-establish defaults after the targeted resets above.
    mockDeleteSession.mockResolvedValue(undefined)
    mockDeleteUser.mockResolvedValue(undefined)
    mockBatchCommit.mockResolvedValue(undefined)
    // No units in any company by default — anonymisation has nothing to rewrite.
    mockUnitsGroupGet.mockResolvedValue({ docs: [] })
    // Default collectionGroup count: 2 admins (safe, does not block).
    // mockCollectionGroupGet receives { _companyId } — default ignores it and
    // always returns 2 so single-company tests stay simple.
    mockCollectionGroupGet.mockResolvedValue(makeCountSnap(2))
    // Default memberships: empty (no companies — no count queries issued).
    mockMembershipsGet.mockResolvedValue(makeMembershipsSnap([]))
  })

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('allows deletion when the user is admin of one company and another admin exists', async () => {
    stubSession()

    // User has one admin membership in company-A.
    mockMembershipsGet.mockResolvedValue(
      makeMembershipsSnap([{ companyId: 'company-A', role: 'admin' }]),
    )

    // company-A has 2 admins (this user + one other) — safe to delete.
    mockCollectionGroupGet.mockResolvedValue(makeCountSnap(2))

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockDeleteSession).toHaveBeenCalledOnce()
    expect(mockDeleteUser).toHaveBeenCalledOnce()
  })

  // ── Block cases ─────────────────────────────────────────────────────────────

  it('blocks deletion when the user is the sole admin of their active company', async () => {
    stubSession({ activeCompanyId: 'company-A' })

    // One admin membership in company-A.
    mockMembershipsGet.mockResolvedValue(
      makeMembershipsSnap([{ companyId: 'company-A', role: 'admin' }]),
    )

    // company-A has only 1 admin — this user. Deletion must be blocked.
    mockCollectionGroupGet.mockResolvedValue(makeCountSnap(1))

    const result = await deleteAccount()

    // Assert the guard's own message, not merely that *some* error came back:
    // for a long time this test passed on a mock TypeError instead.
    expect(result.error).toBe(SOLE_ADMIN_ERROR)
    expect(mockCollectionGroupGet).toHaveBeenCalled()
    expect(mockDeleteSession).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })

  it('blocks deletion when the user is the sole admin of a NON-active company', async () => {
    // Active company is company-A (2 admins — safe).
    // Non-active company is company-B (1 admin — this user — must block).
    stubSession({ activeCompanyId: 'company-A' })

    mockMembershipsGet.mockResolvedValue(
      makeMembershipsSnap([
        { companyId: 'company-A', role: 'admin' },
        { companyId: 'company-B', role: 'admin' },
      ]),
    )

    // Route by companyId — avoids brittle call-order assumptions.
    mockCollectionGroupGet.mockImplementation(({ companyId }: { companyId?: string }) =>
      Promise.resolve(makeCountSnap(companyId === 'company-B' ? 1 : 2)),
    )

    const result = await deleteAccount()

    expect(result.error).toBe(SOLE_ADMIN_ERROR)
    expect(mockCollectionGroupGet).toHaveBeenCalled()
    expect(mockDeleteSession).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })

  // ── Allow after transfer ────────────────────────────────────────────────────

  it('allows deletion when the user transferred ownership in all companies they admin', async () => {
    // Same two-company setup, but company-B now has a second admin.
    stubSession({ activeCompanyId: 'company-A' })

    mockMembershipsGet.mockResolvedValue(
      makeMembershipsSnap([
        { companyId: 'company-A', role: 'admin' },
        { companyId: 'company-B', role: 'admin' },
      ]),
    )

    // Both companies have 2 admins — deletion is safe.
    // Default mock already returns makeCountSnap(2) for all companies.

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockDeleteSession).toHaveBeenCalledOnce()
    expect(mockDeleteUser).toHaveBeenCalledOnce()
  })

  // ── Edge cases ──────────────────────────────────────────────────────────────

  it('allows deletion when the user has no memberships at all', async () => {
    stubSession()

    // Empty memberships subcollection — no companies to orphan.
    mockMembershipsGet.mockResolvedValue(makeMembershipsSnap([]))

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockDeleteSession).toHaveBeenCalledOnce()
    expect(mockDeleteUser).toHaveBeenCalledOnce()
    // No admin membership means no count queries should be issued.
    expect(mockCollectionGroupGet).not.toHaveBeenCalled()
  })

  it('allows deletion when the user is crew (not admin) in every company', async () => {
    stubSession()

    // Two memberships, neither is admin — no count queries needed.
    mockMembershipsGet.mockResolvedValue(
      makeMembershipsSnap([
        { companyId: 'company-A', role: 'crew' },
        { companyId: 'company-B', role: 'crew' },
      ]),
    )

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockDeleteSession).toHaveBeenCalledOnce()
    expect(mockDeleteUser).toHaveBeenCalledOnce()
    // No admin membership means no count queries should be issued.
    expect(mockCollectionGroupGet).not.toHaveBeenCalled()
  })

  // ── Network error resilience ────────────────────────────────────────────────

  it('returns { error } and does not throw when the memberships fetch fails', async () => {
    stubSession()

    // Simulate a Firestore network error during the sole-admin guard.
    mockMembershipsGet.mockRejectedValue(new Error('Firestore unavailable'))

    // deleteAccount must catch the error and return gracefully — never throw.
    const result = await deleteAccount()

    // Distinguish a caught Firestore failure from the guard's own refusal.
    expect(mockMembershipsGet).toHaveBeenCalled()
    expect(result.error).toBe('Failed to delete account')
    // Session must not be deleted when the guard itself failed.
    expect(mockDeleteSession).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })
})
