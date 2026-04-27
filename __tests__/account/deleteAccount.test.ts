/**
 * deleteAccount — multi-company sole-admin guard (issue #90)
 *
 * The current implementation only checks whether the user is the sole admin in
 * their ACTIVE company. If they belong to a second company where they are the
 * only admin, the current code lets the deletion proceed, orphaning that company.
 *
 * The planned fix iterates ALL of the user's memberships (via
 * `users/{uid}/memberships`), and for each membership where role === 'admin'
 * runs a collectionGroup count against `memberships` filtered by companyId and
 * role === 'admin'. If any company has count <= 1, deletion is blocked.
 *
 * These tests are written FIRST — they will fail against the current code and
 * must pass once the fix is implemented. The contract is:
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
  mockUserDocDelete,
  mockDeleteSession,
  mockMembershipsGet,       // users/{uid}/memberships collection .get()
  mockCollectionGroupGet,   // collectionGroup count .get()
} = vi.hoisted(() => ({
  mockVerifySessionCookie:  vi.fn(),
  mockCookieGet:            vi.fn(),
  mockCookieDelete:         vi.fn(),
  mockDeleteUser:           vi.fn(),
  mockUserDocDelete:        vi.fn(),
  mockDeleteSession:        vi.fn(),
  mockMembershipsGet:       vi.fn(),
  mockCollectionGroupGet:   vi.fn(),
}))

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/firebase-admin', () => {
  // Build a chainable collectionGroup mock that supports both access patterns:
  //
  //   Current code:  collectionGroup(...).where(...).where(...).get()
  //   Planned fix:   collectionGroup(...).where(...).where(...).count().get()
  //
  // Each collectionGroup() call returns a fresh chain that captures the
  // companyId from the first .where('companyId', '==', <id>) call. The
  // captured id is forwarded to mockCollectionGroupGet({ _companyId }) so
  // tests can route the response based on which company is being queried —
  // without relying on brittle call-order assumptions.
  const collectionGroupMock = vi.fn(() => {
    let _companyId: string | undefined
    const chain: Record<string, unknown> = {}
    chain['where'] = (field: string, _op: string, value: unknown) => {
      if (field === 'companyId') _companyId = value as string
      return chain
    }
    chain['get']   = () => mockCollectionGroupGet({ _companyId })   // current .where().where().get()
    chain['count'] = () => ({ get: () => mockCollectionGroupGet({ _companyId }) }) // fixed .count().get()
    return chain
  })

  // Build a chainable collection mock.
  //
  // Two access patterns share the same chain:
  //   adminDb.collection('users').doc(uid).collection('memberships').get()
  //   adminDb.collection('users').doc(uid).delete()
  //
  // The inner collection() call (for 'memberships') returns an object whose
  // .get() is our mockMembershipsGet spy.
  const membershipsColl = { get: mockMembershipsGet }
  const userDoc = {
    collection: () => membershipsColl,
    delete:     mockUserDocDelete,
    update:     vi.fn(),
  }
  const collectionMock = vi.fn(() => ({ doc: () => userDoc }))

  return {
    adminAuth: {
      verifySessionCookie: mockVerifySessionCookie,
      deleteUser:          mockDeleteUser,
    },
    adminDb: {
      collection:      collectionMock,
      collectionGroup: collectionGroupMock,
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
    docs: memberships.map(m => ({ data: () => m })),
  }
}

/**
 * Build a fake count snapshot compatible with both access patterns:
 *
 *   Current code:  .where().where().get()       → reads .size
 *   Planned fix:   .where().where().count().get() → reads .data().count
 *
 * By including both fields the same mock works regardless of which path the
 * implementation takes. Tests that assert on blocking/allowing behaviour are
 * not affected by which field the implementation reads.
 */
function makeCountSnap(count: number) {
  return {
    size: count,                   // consumed by current implementation
    data: () => ({ count }),       // consumed by fixed implementation
  }
}

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

    // Re-establish defaults after the targeted resets above.
    mockDeleteSession.mockResolvedValue(undefined)
    mockUserDocDelete.mockResolvedValue(undefined)
    mockDeleteUser.mockResolvedValue(undefined)
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

    expect(result.error).toBeDefined()
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
    mockCollectionGroupGet.mockImplementation(({ _companyId }: { _companyId?: string }) =>
      Promise.resolve(makeCountSnap(_companyId === 'company-B' ? 1 : 2)),
    )

    const result = await deleteAccount()

    expect(result.error).toBeDefined()
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

    expect(result.error).toBeDefined()
    // Session must not be deleted when the guard itself failed.
    expect(mockDeleteSession).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })
})
