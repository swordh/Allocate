/**
 * deleteAccount — issue #252 PR-2: transactional sole-admin guard.
 *
 * Two phases now (actions/account.ts):
 *
 *   1. Pre-flight (read-only, best-effort): reads `_meta/memberCounts`
 *      (lib/companyStats.ts) per admin membership and rejects up front if any
 *      is <= 1. Exists purely to fail fast with a clear message before any
 *      writes — it is NOT authoritative, and a stale answer in either
 *      direction is always corrected by phase 2.
 *   2. Commit loop: one `runTransaction` per company, sequential. Reads the
 *      counter, the caller's own company-side member doc, and the company
 *      doc itself; skips the company outright if it no longer exists (the
 *      fix for issue #252 point 2 — see the dedicated test below); rejects a
 *      sole-admin company for real; otherwise deletes the member doc and
 *      applies the memberCounts delta, all inside the transaction.
 *
 * The pre-existing collectionGroup('memberships') query is gone entirely —
 * it duplicated the user-side `role` field this guard already reads to build
 * `adminMemberships`, so it could never actually disagree with it while still
 * requiring a collection-group index. Company-side `_meta/memberCounts` is
 * the only source of truth left.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  wireDb,
  filterValue,
  makeTransaction,
  type DocMap,
  type QueryResolver,
  type QueryDocInput,
} from '../helpers/firestore'

// ── Hoisted spies ─────────────────────────────────────────────────────────────

const {
  mockVerifySessionCookie,
  mockCookieGet,
  mockCookieDelete,
  mockDeleteUser,
  mockDeleteSession,
} = vi.hoisted(() => ({
  mockVerifySessionCookie: vi.fn(),
  mockCookieGet: vi.fn(),
  mockCookieDelete: vi.fn(),
  mockDeleteUser: vi.fn(),
  mockDeleteSession: vi.fn(),
}))

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => 'server-timestamp',
    // memberCountsDelta (lib/companyStats.ts, exercised via deleteAccount)
    // calls FieldValue.increment — real module, not mocked, so this must
    // exist for that import to resolve.
    increment: (n: number) => ({ __increment: n }),
  },
}))

vi.mock('@/lib/firebase-admin', () => ({
  adminAuth: {
    verifySessionCookie: mockVerifySessionCookie,
    deleteUser: mockDeleteUser,
  },
  adminDb: {
    doc: vi.fn(),
    collection: vi.fn(),
    collectionGroup: vi.fn(),
    batch: vi.fn(),
    runTransaction: vi.fn(),
  },
}))

vi.mock('next/headers', () => {
  const store = {
    get: mockCookieGet,
    set: vi.fn(),
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
import { adminDb } from '@/lib/firebase-admin'

const UID = 'user-1'

/** Byte-identical to what this guard has always returned. */
const SOLE_ADMIN_ERROR =
  'Cannot delete account: you are the only admin of one of your companies. Transfer ownership first.'

/** New in this PR: what the user sees when the guard itself couldn't be evaluated. */
const COULD_NOT_VERIFY_ERROR =
  'Could not verify your company administrators right now. Nothing was deleted — please try again in a moment.'

// ── Scenario wiring ───────────────────────────────────────────────────────────

interface CompanyFixture {
  /** Default true. `false` simulates a stale users/{uid}/memberships/{cid}
   * pointer whose company document was deleted. */
  exists?: boolean
  /** Role on companies/{cid}/members/{uid}. Omit to simulate that doc missing. */
  memberRole?: string
  /** companies/{cid}/_meta/memberCounts. Omit to force the self-heal /
   * preflight aggregate-fallback path. */
  metaCounts?: { members: number; admins: number }
  /** Members subcollection docs, used only when metaCounts is omitted. */
  members?: QueryDocInput[]
  createdBy?: string
}

interface Scenario {
  memberships: Array<{ companyId: string; role: string }>
  companies?: Record<string, CompanyFixture>
  /** Custom resolver for companies/{cid}/invitations queries. Defaults to empty. */
  invitations?: QueryResolver
  /** Simulates the initial `users/{uid}/memberships` read itself failing. */
  membershipsFetchError?: Error
}

function wireScenario(scenario: Scenario) {
  const docs: DocMap = {}

  for (const [companyId, fixture] of Object.entries(scenario.companies ?? {})) {
    const exists = fixture.exists ?? true
    docs[`companies/${companyId}`] = exists
      ? { name: companyId, createdBy: fixture.createdBy ?? null }
      : null
    if (fixture.memberRole !== undefined) {
      docs[`companies/${companyId}/members/${UID}`] = { role: fixture.memberRole }
    }
    if (fixture.metaCounts) {
      docs[`companies/${companyId}/_meta/memberCounts`] = fixture.metaCounts
    }
  }

  const membershipDocs: QueryDocInput[] = scenario.memberships.map((m, i) => ({
    id: `membership-${i}`,
    path: `users/${UID}/memberships/membership-${i}`,
    data: m,
  }))

  const query: QueryResolver = (ctx) => {
    if (ctx.path === `users/${UID}/memberships`) {
      if (scenario.membershipsFetchError) throw scenario.membershipsFetchError
      return membershipDocs
    }

    if (ctx.path.endsWith('/invitations')) {
      return scenario.invitations ? scenario.invitations(ctx) : []
    }

    // The preflight's aggregate fallback AND readMemberCounts's self-heal
    // both query companies/{cid}/members directly (not a collection group).
    const membersMatch = ctx.path.match(/^companies\/([^/]+)\/members$/)
    if (membersMatch) {
      const fixture = scenario.companies?.[membersMatch[1] as string]
      const allMembers = fixture?.members ?? []
      const roleFilter = filterValue(ctx, 'role')
      return roleFilter
        ? allMembers.filter((d) => (d.data as { role?: string }).role === roleFilter)
        : allMembers
    }

    // Bookings/equipment — nothing to anonymise by default in these tests.
    return []
  }

  const wired = wireDb(adminDb as unknown as Record<string, unknown>, {
    docs,
    query,
    collectionGroup: () => [], // 'units' — no unit docs to anonymise in these tests
  })

  const tx = makeTransaction(docs)
  vi.mocked(adminDb.runTransaction).mockImplementation(
    (cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx),
  )

  return { docs, wired, tx }
}

/**
 * Stub getVerifiedSession by controlling what verifySessionCookie returns.
 */
function stubSession(overrides?: Partial<{ uid: string; activeCompanyId: string; email: string }>) {
  mockCookieGet.mockReturnValue({ value: 'valid-session-token' })
  mockVerifySessionCookie.mockResolvedValue({
    uid:             overrides?.uid             ?? UID,
    email:           overrides?.email           ?? 'user@example.com',
    activeCompanyId: overrides?.activeCompanyId ?? 'company-A',
    role:            'admin',
    email_verified:  true,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDeleteSession.mockResolvedValue(undefined)
  mockDeleteUser.mockResolvedValue(undefined)
})

// ── Guard: pre-flight + commit-loop ────────────────────────────────────────────

describe('deleteAccount — multi-company sole-admin guard (#90, transactional as of #252)', () => {
  it('allows deletion when the user is admin of one company and another admin exists', async () => {
    stubSession()
    wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: { 'company-A': { memberRole: 'admin', metaCounts: { members: 5, admins: 2 } } },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockDeleteSession).toHaveBeenCalledOnce()
    expect(mockDeleteUser).toHaveBeenCalledOnce()
  })

  it('blocks deletion at the pre-flight stage when the user is the sole admin of their active company', async () => {
    stubSession({ activeCompanyId: 'company-A' })
    wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: { 'company-A': { memberRole: 'admin', metaCounts: { members: 1, admins: 1 } } },
    })

    const result = await deleteAccount()

    // Assert the guard's own message, not merely that *some* error came back.
    expect(result.error).toBe(SOLE_ADMIN_ERROR)
    // Blocked before the commit loop ever starts a transaction.
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
    expect(mockDeleteSession).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })

  it('blocks deletion when the user is the sole admin of a NON-active company', async () => {
    // Active company is company-A (2 admins — safe).
    // Non-active company is company-B (1 admin — this user — must block).
    stubSession({ activeCompanyId: 'company-A' })
    wireScenario({
      memberships: [
        { companyId: 'company-A', role: 'admin' },
        { companyId: 'company-B', role: 'admin' },
      ],
      companies: {
        'company-A': { memberRole: 'admin', metaCounts: { members: 5, admins: 2 } },
        'company-B': { memberRole: 'admin', metaCounts: { members: 1, admins: 1 } },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBe(SOLE_ADMIN_ERROR)
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
    expect(mockDeleteSession).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })

  it('allows deletion when the user transferred ownership in all companies they admin', async () => {
    stubSession({ activeCompanyId: 'company-A' })
    wireScenario({
      memberships: [
        { companyId: 'company-A', role: 'admin' },
        { companyId: 'company-B', role: 'admin' },
      ],
      companies: {
        'company-A': { memberRole: 'admin', metaCounts: { members: 5, admins: 2 } },
        'company-B': { memberRole: 'admin', metaCounts: { members: 3, admins: 2 } },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockDeleteSession).toHaveBeenCalledOnce()
    expect(mockDeleteUser).toHaveBeenCalledOnce()
  })

  it('allows deletion when the user has no memberships at all', async () => {
    stubSession()
    wireScenario({ memberships: [] })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockDeleteSession).toHaveBeenCalledOnce()
    expect(mockDeleteUser).toHaveBeenCalledOnce()
    // No companies to iterate — the commit loop never opens a transaction.
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
  })

  it('allows deletion when the user is crew (not admin) in every company', async () => {
    stubSession()
    wireScenario({
      memberships: [
        { companyId: 'company-A', role: 'crew' },
        { companyId: 'company-B', role: 'crew' },
      ],
      companies: {
        'company-A': { memberRole: 'crew', metaCounts: { members: 3, admins: 1 } },
        'company-B': { memberRole: 'crew', metaCounts: { members: 2, admins: 1 } },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockDeleteSession).toHaveBeenCalledOnce()
    expect(mockDeleteUser).toHaveBeenCalledOnce()
    // Not-admin-anywhere no longer means "no queries issued" the way it did
    // under the old guard (every company still gets a transaction — role is
    // only known once the member doc is read inside it). What it DOES still
    // guarantee: neither transaction's guard fires, and both proceed to
    // delete + decrement.
    expect(adminDb.runTransaction).toHaveBeenCalledTimes(2)
  })

  it('returns { error } and does not throw when the memberships fetch fails', async () => {
    stubSession()
    wireScenario({ memberships: [], membershipsFetchError: new Error('Firestore unavailable') })

    const result = await deleteAccount()

    // Distinguish a caught Firestore failure from the guard's own refusal —
    // and from the unrelated anonymisation-phase failure message, which this
    // is not: the pre-flight has its own dedicated message so the two are
    // distinguishable in Cloud Logging (action strings differ) as well as to
    // the user.
    expect(result.error).toBe(COULD_NOT_VERIFY_ERROR)
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
    expect(mockDeleteSession).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })

  // ── The single most important regression in this file ───────────────────────
  //
  // Before this PR, a leftover users/{uid}/memberships/{cid} doc pointing at
  // a company that no longer exists was counted as a live admin membership —
  // and since a deleted company can never gain a second admin, this
  // permanently blocked account deletion. The fix: the commit loop's
  // transaction checks `!companySnap.exists` FIRST and skips the company
  // entirely — no guard, no delete, no delta — so deletion goes through.
  it('skips a company whose document no longer exists — stale pointer no longer blocks deletion', async () => {
    stubSession()
    const { tx } = wireScenario({
      memberships: [{ companyId: 'company-orphaned', role: 'admin' }],
      companies: { 'company-orphaned': { exists: false } },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    // No member doc to delete, no counter to touch, for the orphaned company.
    expect(tx.delete).not.toHaveBeenCalled()
    expect(tx.set).not.toHaveBeenCalled()
    expect(mockDeleteSession).toHaveBeenCalledOnce()
    expect(mockDeleteUser).toHaveBeenCalledOnce()
  })

  it('rejects for real inside the commit loop when the pre-flight read was stale (race)', async () => {
    // Pre-flight sees 2 admins (safe) and lets the request through; by the
    // time the commit-loop transaction runs, a concurrent removal already
    // dropped it to 1. This is what "pre-flight is not authoritative" means
    // in practice — the transaction is the last word. The two phases are
    // deliberately wired against DIFFERENT snapshots of `_meta/memberCounts`
    // to simulate that race explicitly, rather than relying on them
    // coincidentally reading the same mutable object.
    stubSession()

    const preflightDocs: DocMap = {
      'companies/company-A': { name: 'Acme' },
      'companies/company-A/_meta/memberCounts': { members: 3, admins: 2 },
    }
    const txDocs: DocMap = {
      'companies/company-A': { name: 'Acme' },
      [`companies/company-A/members/${UID}`]: { role: 'admin' },
      'companies/company-A/_meta/memberCounts': { members: 3, admins: 1 },
    }

    const query: QueryResolver = (ctx) =>
      ctx.path === `users/${UID}/memberships`
        ? [{ id: 'm0', path: `users/${UID}/memberships/m0`, data: { companyId: 'company-A', role: 'admin' } }]
        : []

    wireDb(adminDb as unknown as Record<string, unknown>, { docs: preflightDocs, query })
    const tx = makeTransaction(txDocs)
    vi.mocked(adminDb.runTransaction).mockImplementation(
      (cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx),
    )

    const result = await deleteAccount()

    expect(result.error).toBe(SOLE_ADMIN_ERROR)
    expect(tx.delete).not.toHaveBeenCalled()
  })
})

// ── Invitation anonymisation ───────────────────────────────────────────────────
//
// companies/{cid}/invitations carries this user's PII in three roles
// (acceptedBy, invitedBy/invitedByName, revokedBy) that must be nulled, plus
// pending invitations still addressed TO the deleted user, which are deleted
// outright (subcollection doc + top-level invitations/{token} mirror) rather
// than anonymised, since the invite can never be accepted after the account
// is gone. Unaffected by this PR's guard rewrite — these exercise phase 3
// (the anonymisation WriteBatch), which is unchanged.

describe('deleteAccount — invitation anonymisation', () => {
  const BASE_SCENARIO = {
    memberships: [{ companyId: 'company-A', role: 'crew' }],
    companies: { 'company-A': { memberRole: 'crew', metaCounts: { members: 3, admins: 1 } } },
  } satisfies Scenario

  it('nulls email and acceptedBy on the invitation that brought this user in', async () => {
    stubSession()
    const { wired } = wireScenario({
      ...BASE_SCENARIO,
      invitations: (ctx) =>
        filterValue(ctx, 'acceptedBy') === UID
          ? [{
              id: 'inv-1',
              path: 'companies/company-A/invitations/inv-1',
              data: { email: 'user@example.com', acceptedBy: UID, status: 'accepted' },
            }]
          : [],
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(wired.batch.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'inv-1' }),
      { email: null, acceptedBy: null },
    )
  })

  it('nulls invitedBy and invitedByName but leaves the recipient email untouched', async () => {
    stubSession()
    const { wired } = wireScenario({
      ...BASE_SCENARIO,
      invitations: (ctx) =>
        filterValue(ctx, 'invitedBy') === UID
          ? [{
              id: 'inv-2',
              path: 'companies/company-A/invitations/inv-2',
              data: {
                email: 'someone-else@example.com',
                invitedBy: UID,
                invitedByName: 'Deleted User',
                status: 'pending',
              },
            }]
          : [],
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(wired.batch.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'inv-2' }),
      { invitedBy: null, invitedByName: null },
    )
    expect(wired.batch.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'inv-2' }),
      expect.objectContaining({ email: expect.anything() }),
    )
  })

  it('nulls revokedBy', async () => {
    stubSession()
    const { wired } = wireScenario({
      ...BASE_SCENARIO,
      invitations: (ctx) =>
        filterValue(ctx, 'revokedBy') === UID
          ? [{
              id: 'inv-3',
              path: 'companies/company-A/invitations/inv-3',
              data: { revokedBy: UID, status: 'revoked' },
            }]
          : [],
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(wired.batch.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'inv-3' }),
      { revokedBy: null },
    )
  })

  it('deletes a still-pending invitation addressed to the deleted user, plus its top-level mirror', async () => {
    stubSession() // session.email = 'user@example.com'
    const { wired } = wireScenario({
      ...BASE_SCENARIO,
      invitations: (ctx) =>
        filterValue(ctx, 'email') === 'user@example.com' && filterValue(ctx, 'status') === 'pending'
          ? [{
              id: 'inv-4',
              path: 'companies/company-A/invitations/inv-4',
              data: { email: 'user@example.com', status: 'pending', token: 'the-token-123' },
            }]
          : [],
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    // Subcollection doc deleted outright (not anonymised).
    expect(wired.batch.delete).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-4' }))
    // Top-level mirror, addressed by token, deleted too.
    expect(wired.batch.delete).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'invitations/the-token-123' }),
    )
  })

  it('matches the pending invitation regardless of the session email casing', async () => {
    // Firebase Auth's email claim casing is not guaranteed to match the
    // lowercased Invitation.email written by normalizeEmail() — this is
    // exactly the ambiguity flagged during review. Asserting the match still
    // succeeds with a mixed-case session email is the regression test for
    // that normalisation.
    stubSession({ email: 'User@Example.com' })
    const { wired } = wireScenario({
      memberships: [{ companyId: 'company-A', role: 'crew' }],
      companies: { 'company-A': { memberRole: 'crew', metaCounts: { members: 3, admins: 1 } } },
      invitations: (ctx) =>
        filterValue(ctx, 'email') === 'user@example.com' && filterValue(ctx, 'status') === 'pending'
          ? [{
              id: 'inv-5',
              path: 'companies/company-A/invitations/inv-5',
              data: { email: 'user@example.com', status: 'pending', token: 'tok-5' },
            }]
          : [],
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(wired.batch.delete).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-5' }))
  })
})

// ── memberCounts delta ──────────────────────────────────────────────────────────
//
// deleteAccount deletes companies/{companyId}/members/{uid} for every company
// the deleted user belongs to (GDPR Art. 17) and applies the memberCounts
// delta (lib/companyStats.ts) in the SAME per-company transaction — see the
// module docblock for why a partial batch failure must never leave the
// member gone but the count stale. This is now proven by construction (one
// transaction per company) rather than by a hand-maintained batch-ordering
// invariant, so these tests check the transaction's writes directly.

describe('deleteAccount — memberCounts delta', () => {
  it('applies the delta on companies/{companyId}/_meta/memberCounts and the stats.memberCount mirror, via merge-sets', async () => {
    stubSession()
    const { tx } = wireScenario({
      memberships: [{ companyId: 'company-A', role: 'crew' }],
      companies: { 'company-A': { memberRole: 'crew', metaCounts: { members: 3, admins: 1 } } },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()

    const metaCall = tx.set.mock.calls.find(
      (c) => (c[0] as { path: string }).path === 'companies/company-A/_meta/memberCounts',
    )
    expect(metaCall).toBeDefined()
    expect(metaCall![1]).toMatchObject({ members: expect.anything(), updatedAt: expect.anything() })
    // Crew target — admins delta is 0 and must be omitted entirely.
    expect(metaCall![1]).not.toHaveProperty('admins')
    expect(metaCall![2]).toMatchObject({ merge: true })

    const statsCall = tx.set.mock.calls.find(
      (c) => (c[0] as { path: string }).path === 'companies/company-A',
    )
    expect(statsCall).toBeDefined()
    expect(statsCall![1]).toMatchObject({
      stats: { memberCount: expect.anything(), updatedAt: expect.anything() },
    })
    expect(statsCall![2]).toMatchObject({ merge: true })

    expect(tx.delete).toHaveBeenCalledWith(
      expect.objectContaining({ path: `companies/company-A/members/${UID}` }),
    )
  })

  it('applies the delta once per company for a user in multiple companies', async () => {
    stubSession()
    const { tx } = wireScenario({
      memberships: [
        { companyId: 'company-A', role: 'crew' },
        { companyId: 'company-B', role: 'crew' },
      ],
      companies: {
        'company-A': { memberRole: 'crew', metaCounts: { members: 3, admins: 1 } },
        'company-B': { memberRole: 'crew', metaCounts: { members: 2, admins: 1 } },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    for (const companyId of ['company-A', 'company-B']) {
      expect(tx.set).toHaveBeenCalledWith(
        expect.objectContaining({ path: `companies/${companyId}/_meta/memberCounts` }),
        expect.anything(),
        expect.objectContaining({ merge: true }),
      )
    }
    expect(adminDb.runTransaction).toHaveBeenCalledTimes(2)
  })

  it('decrements admins too when the deleted user was an admin (with another admin remaining)', async () => {
    stubSession()
    const { tx } = wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: { 'company-A': { memberRole: 'admin', metaCounts: { members: 3, admins: 2 } } },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    const metaCall = tx.set.mock.calls.find(
      (c) => (c[0] as { path: string }).path === 'companies/company-A/_meta/memberCounts',
    )
    expect(metaCall![1]).toMatchObject({ admins: expect.anything() })
  })

  it('self-heals _meta/memberCounts from a live aggregate when the counter is missing', async () => {
    stubSession()
    const { tx } = wireScenario({
      memberships: [{ companyId: 'company-A', role: 'crew' }],
      companies: {
        'company-A': {
          memberRole: 'crew',
          // No metaCounts — forces readMemberCounts's self-heal branch.
          members: [
            { id: 'a', data: { role: 'admin' } },
            { id: 'b', data: { role: 'crew' } },
          ],
        },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    const metaCall = tx.set.mock.calls.find(
      (c) => (c[0] as { path: string }).path === 'companies/company-A/_meta/memberCounts',
    )
    expect(metaCall).toBeDefined()
  })

  it('idempotence: a company whose member doc is already gone contributes no delta and does not error', async () => {
    // Models a retry after a partial failure on an earlier attempt: this
    // company's member doc and delta were already committed, so a second
    // pass must skip it — not decrement `_meta/memberCounts` a second time.
    // Role is 'crew' (on the still-stale user-side membership doc) rather
    // than 'admin' specifically to keep this test about the commit loop's
    // idempotence, not the pre-flight guard's own read of a membership doc
    // that a prior partial run already made stale — a real but separate edge
    // case outside this test's scope.
    stubSession()
    const { tx } = wireScenario({
      memberships: [{ companyId: 'company-A', role: 'crew' }],
      companies: { 'company-A': { metaCounts: { members: 2, admins: 1 } } }, // no memberRole => member doc missing
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(tx.delete).not.toHaveBeenCalled()
    expect(tx.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: 'companies/company-A/_meta/memberCounts' }),
      expect.anything(),
      expect.anything(),
    )
  })

  it('aborts with the partial-removal message and stops before anonymising anything when a later company fails indeterminately', async () => {
    stubSession()

    const docsA: DocMap = {
      'companies/company-A': { name: 'A' },
      [`companies/company-A/members/${UID}`]: { role: 'crew' },
      'companies/company-A/_meta/memberCounts': { members: 3, admins: 1 },
    }

    const query: QueryResolver = (ctx) =>
      ctx.path === `users/${UID}/memberships`
        ? [
            { id: 'm0', path: `users/${UID}/memberships/m0`, data: { companyId: 'company-A', role: 'crew' } },
            { id: 'm1', path: `users/${UID}/memberships/m1`, data: { companyId: 'company-B', role: 'crew' } },
          ]
        : []

    wireDb(adminDb as unknown as Record<string, unknown>, { docs: docsA, query })

    // company-A's transaction succeeds normally; company-B's simulates an
    // indeterminate failure (e.g. a transient Firestore error) rather than a
    // real sole-admin block.
    let call = 0
    vi.mocked(adminDb.runTransaction).mockImplementation(async (cb: unknown) => {
      call += 1
      if (call === 1) {
        const tx = makeTransaction(docsA)
        return (cb as (tx: unknown) => Promise<unknown>)(tx)
      }
      throw new Error('Simulated transient Firestore failure for company-B')
    })

    const result = await deleteAccount()

    expect(result.error).toBe(COULD_NOT_VERIFY_ERROR)
    expect(call).toBe(2)
    expect(mockDeleteSession).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })
})
