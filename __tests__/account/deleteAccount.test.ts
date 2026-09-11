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
  mockInvitationsGet,       // adminDb.collection('companies/{id}/invitations').where(...).get()
  mockBatchCommit,
  mockBatchDelete,
  mockBatchUpdate,
  mockBatchSet,
} = vi.hoisted(() => ({
  mockVerifySessionCookie:  vi.fn(),
  mockCookieGet:            vi.fn(),
  mockCookieDelete:         vi.fn(),
  mockDeleteUser:           vi.fn(),
  mockDeleteSession:        vi.fn(),
  mockMembershipsGet:       vi.fn(),
  mockCollectionGroupGet:   vi.fn(),
  mockUnitsGroupGet:        vi.fn(),
  mockInvitationsGet:       vi.fn(),
  mockBatchCommit:          vi.fn(),
  mockBatchDelete:          vi.fn(),
  // Simulates real Firestore .update() semantics for one sentinel path used
  // by the "stale membership pointer" regression test below: .update()
  // throws NOT_FOUND against a document that doesn't exist, exactly like the
  // real SDK does, while .set() (mockBatchSet) never throws regardless of
  // existence. No other test in this file uses 'companies/company-orphaned',
  // so this is safe to bake into the shared mock rather than wire per-test.
  mockBatchUpdate: vi.fn((ref: { path?: string } = {}) => {
    if (ref.path === 'companies/company-orphaned') {
      throw new Error('5 NOT_FOUND: No document to update: companies/company-orphaned')
    }
  }),
  mockBatchSet:             vi.fn(),
}))

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => 'server-timestamp',
    // memberCountDelta (lib/companyStats.ts, exercised via deleteAccount)
    // calls FieldValue.increment — real module, not mocked, so this must
    // exist for that import to resolve.
    increment: (n: number) => ({ __increment: n }),
  },
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

  // companies/{id}/invitations is queried four separate times per company
  // (acceptedBy, invitedBy, revokedBy, then email+status) — each .where()
  // call narrows a fresh filter object, and .get() hands the accumulated
  // filters to mockInvitationsGet so a test can route by which query ran,
  // the same way collectionGroupMock routes 'units' vs 'memberships' by
  // companyId above.
  function makeInvitationsChain(companyId: string) {
    const filters: Record<string, unknown> = {}
    const chain: Record<string, unknown> = {}
    chain['where'] = (field: string, _op: string, val: unknown) => {
      filters[field] = val
      return chain
    }
    chain['get'] = () => mockInvitationsGet({ companyId, ...filters })
    return chain
  }

  const collectionMock = vi.fn((path: string) => {
    if (path.endsWith('/invitations')) {
      const companyId = path.split('/')[1]
      return makeInvitationsChain(companyId)
    }
    return {
      path,
      doc: (id?: string) => makeRef(id ? `${path}/${id}` : `${path}/auto-id`),
      where: emptyChain['where'],
      get: path.endsWith('/memberships')
        ? mockMembershipsGet
        : (emptyChain['get'] as () => Promise<{ docs: [] }>),
    }
  })

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
    set:    mockBatchSet,
    update: mockBatchUpdate,
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
    mockInvitationsGet.mockReset()

    // Re-establish defaults after the targeted resets above.
    mockDeleteSession.mockResolvedValue(undefined)
    mockDeleteUser.mockResolvedValue(undefined)
    mockBatchCommit.mockResolvedValue(undefined)
    // No units in any company by default — anonymisation has nothing to rewrite.
    mockUnitsGroupGet.mockResolvedValue({ docs: [] })
    // No invitations to anonymise/delete by default.
    mockInvitationsGet.mockResolvedValue({ docs: [] })
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

// ── Invitation anonymisation ───────────────────────────────────────────────────
//
// companies/{cid}/invitations carries this user's PII in three roles
// (acceptedBy, invitedBy/invitedByName, revokedBy) that must be nulled, plus
// pending invitations still addressed TO the deleted user, which are deleted
// outright (subcollection doc + top-level invitations/{token} mirror) rather
// than anonymised, since the invite can never be accepted after the account
// is gone.

/** Build a minimal invitation doc as returned by an invitations query. */
function makeInvitationDoc(id: string, data: Record<string, unknown>) {
  return {
    id,
    data: () => data,
    ref: { path: `companies/company-A/invitations/${id}`, id },
  }
}

describe('deleteAccount — invitation anonymisation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCollectionGroupGet.mockReset()
    mockMembershipsGet.mockReset()
    mockUnitsGroupGet.mockReset()
    mockInvitationsGet.mockReset()

    mockDeleteSession.mockResolvedValue(undefined)
    mockDeleteUser.mockResolvedValue(undefined)
    mockBatchCommit.mockResolvedValue(undefined)
    mockUnitsGroupGet.mockResolvedValue({ docs: [] })
    mockCollectionGroupGet.mockResolvedValue(makeCountSnap(2))

    // Single company, user is crew — the sole-admin guard is not what these
    // tests are about, so keep it out of the way.
    mockMembershipsGet.mockResolvedValue(
      makeMembershipsSnap([{ companyId: 'company-A', role: 'crew' }]),
    )
  })

  it('nulls email and acceptedBy on the invitation that brought this user in', async () => {
    stubSession()

    mockInvitationsGet.mockImplementation(({ acceptedBy }: { acceptedBy?: string }) => {
      if (acceptedBy === 'user-1') {
        return Promise.resolve({
          docs: [makeInvitationDoc('inv-1', { email: 'user@example.com', acceptedBy: 'user-1', status: 'accepted' })],
        })
      }
      return Promise.resolve({ docs: [] })
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockBatchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'inv-1' }),
      { email: null, acceptedBy: null },
    )
  })

  it('nulls invitedBy and invitedByName but leaves the recipient email untouched', async () => {
    stubSession()

    mockInvitationsGet.mockImplementation(({ invitedBy }: { invitedBy?: string }) => {
      if (invitedBy === 'user-1') {
        return Promise.resolve({
          docs: [
            makeInvitationDoc('inv-2', {
              email: 'someone-else@example.com',
              invitedBy: 'user-1',
              invitedByName: 'Deleted User',
              status: 'pending',
            }),
          ],
        })
      }
      return Promise.resolve({ docs: [] })
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockBatchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'inv-2' }),
      { invitedBy: null, invitedByName: null },
    )
    // The recipient's own email must never be touched by this query.
    expect(mockBatchUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'inv-2' }),
      expect.objectContaining({ email: expect.anything() }),
    )
  })

  it('nulls revokedBy', async () => {
    stubSession()

    mockInvitationsGet.mockImplementation(({ revokedBy }: { revokedBy?: string }) => {
      if (revokedBy === 'user-1') {
        return Promise.resolve({
          docs: [makeInvitationDoc('inv-3', { revokedBy: 'user-1', status: 'revoked' })],
        })
      }
      return Promise.resolve({ docs: [] })
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockBatchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'inv-3' }),
      { revokedBy: null },
    )
  })

  it('deletes a still-pending invitation addressed to the deleted user, plus its top-level mirror', async () => {
    stubSession() // session.email = 'user@example.com'

    mockInvitationsGet.mockImplementation(
      ({ email, status }: { email?: string; status?: string }) => {
        if (email === 'user@example.com' && status === 'pending') {
          return Promise.resolve({
            docs: [
              makeInvitationDoc('inv-4', {
                email: 'user@example.com',
                status: 'pending',
                token: 'the-token-123',
              }),
            ],
          })
        }
        return Promise.resolve({ docs: [] })
      },
    )

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    // Subcollection doc deleted outright (not anonymised).
    expect(mockBatchDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-4' }))
    // Top-level mirror, addressed by token, deleted too.
    expect(mockBatchDelete).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'invitations/the-token-123' }),
    )
  })

  it('matches the pending invitation regardless of the session email casing', async () => {
    // Firebase Auth's email claim casing is not guaranteed to match the
    // lowercased Invitation.email written by normalizeEmail() — this is
    // exactly the ambiguity flagged during review. Asserting the match still
    // succeeds with a mixed-case session email is the regression test for
    // that normalisation.
    mockCookieGet.mockReturnValue({ value: 'valid-session-token' })
    mockVerifySessionCookie.mockResolvedValue({
      uid:             'user-1',
      email:           'User@Example.com',
      activeCompanyId: 'company-A',
      role:            'crew',
      email_verified:  true,
    })

    mockInvitationsGet.mockImplementation(
      ({ email, status }: { email?: string; status?: string }) => {
        if (email === 'user@example.com' && status === 'pending') {
          return Promise.resolve({
            docs: [makeInvitationDoc('inv-5', { email: 'user@example.com', status: 'pending', token: 'tok-5' })],
          })
        }
        return Promise.resolve({ docs: [] })
      },
    )

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockBatchDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-5' }))
  })
})

// ── memberCount decrement ──────────────────────────────────────────────────────
//
// deleteAccount deletes companies/{companyId}/members/{uid} for every company
// the deleted user belongs to (GDPR Art. 17), and must decrement
// companies/{companyId}.stats.memberCount via memberCountDelta (lib/companyStats.ts)
// immediately after — mirrors removeMember's identical requirement
// (actions/team.ts, __tests__/team/removeMember.test.ts) for the same reason:
// a partial batch failure must never leave the member gone but the count stale.
//
// memberCountDelta uses `.set(..., { merge: true })`, never `.update()`. This
// matters specifically here: `companyIds` is derived from the deleted user's
// own `memberships` documents, which can point at a company doc that no
// longer exists (a stale pointer — the same class of orphan the equipment-
// stats PR was cleaning up, just in the other direction). `.update()` throws
// on a missing document and would fail the entire GDPR-erasure batch over a
// denormalized counter that has no `_meta` backing and is not authoritative
// for anything.

describe('deleteAccount — memberCount decrement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCollectionGroupGet.mockReset()
    mockMembershipsGet.mockReset()
    mockUnitsGroupGet.mockReset()
    mockInvitationsGet.mockReset()

    mockDeleteSession.mockResolvedValue(undefined)
    mockDeleteUser.mockResolvedValue(undefined)
    mockBatchCommit.mockResolvedValue(undefined)
    mockUnitsGroupGet.mockResolvedValue({ docs: [] })
    mockInvitationsGet.mockResolvedValue({ docs: [] })
    mockCollectionGroupGet.mockResolvedValue(makeCountSnap(2))

    // Single company, user is crew — the sole-admin guard is not what this
    // test is about.
    mockMembershipsGet.mockResolvedValue(
      makeMembershipsSnap([{ companyId: 'company-A', role: 'crew' }]),
    )
  })

  it('decrements companies/{companyId}.stats.memberCount via a merge-set, for each company anonymised', async () => {
    stubSession()

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockBatchSet).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'companies/company-A' }),
      expect.objectContaining({
        stats: expect.objectContaining({
          memberCount: expect.anything(),
          updatedAt: expect.anything(),
        }),
      }),
      expect.objectContaining({ merge: true }),
    )

    // Never via .update() — see the block comment above for why that would
    // be unsafe here specifically.
    expect(mockBatchUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: 'companies/company-A' }),
      expect.objectContaining({ 'stats.memberCount': expect.anything() }),
    )
  })

  it('decrements memberCount once per company for a user in multiple companies', async () => {
    stubSession()

    mockMembershipsGet.mockResolvedValue(
      makeMembershipsSnap([
        { companyId: 'company-A', role: 'crew' },
        { companyId: 'company-B', role: 'crew' },
      ]),
    )

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    for (const companyId of ['company-A', 'company-B']) {
      expect(mockBatchSet).toHaveBeenCalledWith(
        expect.objectContaining({ path: `companies/${companyId}` }),
        expect.objectContaining({ stats: expect.objectContaining({ memberCount: expect.anything() }) }),
        expect.objectContaining({ merge: true }),
      )
    }
  })

  it('does not throw when a membership points at a company document that no longer exists', async () => {
    // The stale-pointer scenario the coordinator flagged: `companyIds` comes
    // from the user's own `memberships` docs, so a dangling reference to a
    // deleted company must not turn "delete my account" into a hard failure.
    //
    // This is made real, not vacuous: mockBatchUpdate (see the vi.hoisted()
    // block at the top of this file) throws NOT_FOUND specifically for
    // 'companies/company-orphaned', the way the real Firestore SDK throws
    // when .update() targets a document that doesn't exist. mockBatchSet
    // never throws, regardless of existence — matching real merge-set
    // semantics. So this test fails if memberCountDelta ever regresses to
    // .update(), and passes only because it currently calls .set().
    //
    // Verified by hand: temporarily reverted memberCountDelta (lib/companyStats.ts)
    // to tx.update(...) with the old dot-path payload, re-ran this test file —
    // this test went red with the NOT_FOUND error surfacing as deleteAccount's
    // caught 'Failed to delete account', while every other test in the file
    // stayed green. Reverted back to the merge-set implementation afterward.
    stubSession()

    mockMembershipsGet.mockResolvedValue(
      makeMembershipsSnap([{ companyId: 'company-orphaned', role: 'crew' }]),
    )

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockBatchSet).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'companies/company-orphaned' }),
      expect.objectContaining({ stats: expect.objectContaining({ memberCount: expect.anything() }) }),
      expect.objectContaining({ merge: true }),
    )
    expect(mockDeleteSession).toHaveBeenCalledOnce()
    expect(mockDeleteUser).toHaveBeenCalledOnce()
  })
})
