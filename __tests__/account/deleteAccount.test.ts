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
  type DocRefStub,
} from '../helpers/firestore'

// ── Hoisted spies ─────────────────────────────────────────────────────────────

const {
  mockVerifySessionCookie,
  mockCookieGet,
  mockCookieDelete,
  mockDeleteUser,
  mockDeleteSession,
  mockStripeRetrieve,
  mockStripeUpdate,
} = vi.hoisted(() => ({
  mockVerifySessionCookie: vi.fn(),
  mockCookieGet: vi.fn(),
  mockCookieDelete: vi.fn(),
  mockDeleteUser: vi.fn(),
  mockDeleteSession: vi.fn(),
  mockStripeRetrieve: vi.fn(),
  mockStripeUpdate: vi.fn(),
}))

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => 'server-timestamp',
    // memberCountsDelta (lib/companyStats.ts, exercised via deleteAccount)
    // calls FieldValue.increment — real module, not mocked, so this must
    // exist for that import to resolve.
    increment: (n: number) => ({ __increment: n }),
    // The company-deletion cancel path clears `companies/{cid}.deletion` with
    // FieldValue.delete(); deleteAccount itself never calls it, but the
    // module graph is shared, so it must resolve.
    delete: () => '__delete',
  },
  // issue #252 step 5: deleteAccount now stamps `requestedAt`/`scheduledFor`/
  // `purgeAfter` on the `mode: 'immediate'` ledger row it writes for a
  // sole-member company. Fixed instant so assertions can compare exactly.
  Timestamp: {
    now: () => ({
      toMillis: () => 1_760_000_000_000,
      toDate: () => new Date(1_760_000_000_000),
    }),
    fromMillis: (ms: number) => ({
      toMillis: () => ms,
      toDate: () => new Date(ms),
    }),
  },
}))

// Stripe billing-contact anonymisation (fix/stripe-anonymise-billing-contact)
// — pattern copied from __tests__/subscription/billingPortalDeletionGuard.test.ts.
vi.mock('@/lib/stripe', () => ({
  stripe: {
    customers: { retrieve: mockStripeRetrieve, update: mockStripeUpdate },
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
import { formatDateFull } from '@/lib/companyDeletionCancelWrites'

const UID = 'user-1'

/** What the user sees when the guard itself couldn't be evaluated (a read
 * failed) — distinct from the sole-admin message below, and from the
 * `unknown`-outcome case exercised further down: this is the SAME string for
 * both, since from the user's point of view "a read failed" and "a
 * per-company outcome couldn't be determined" are the same situation. */
const COULD_NOT_VERIFY_ERROR =
  'Could not verify your company administrators right now. Nothing was deleted — please try again in a moment.'

/** Mirrors actions/account.ts's ACCOUNT_DELETION_IN_PROGRESS_ERROR (issue #349). */
const ACCOUNT_DELETION_IN_PROGRESS_ERROR =
  'Account deletion is already in progress. Please wait a moment and try again.'

/** Mirrors actions/account.ts's LOCK_TTL_MS (issue #349). */
const LOCK_TTL_MS = 5 * 60 * 1000

/**
 * Mirrors `actions/account.ts`'s `otherPeoplePhrase` / `buildBlockedClause` /
 * `buildSoleAdminMessage` — kept in sync deliberately, same convention as the
 * constant above: these tests assert the guard's actual user-facing string,
 * not just "some error came back," so a regression in the wording (or in
 * which company and count it names) is caught here, not just a change in
 * *whether* it blocks.
 *
 * `close` no longer has a message at all (issue #252 step 5, PR F2): a
 * company whose sole member deletes her account is now deleted along with it
 * rather than blocking her, so `buildCloseClause` and its mirror here are
 * both gone. `blocked` — sole admin with colleagues — is the only message
 * this guard still builds.
 */
function otherPeoplePhrase(otherCount: number): string {
  if (otherCount <= 0) return 'no one else works'
  if (otherCount === 1) return '1 other person works'
  return `${otherCount} other people work`
}

function blockedClause(companies: Array<{ name: string; memberCount: number }>): string {
  if (companies.length === 1) {
    const c = companies[0]!
    return `you are the only administrator of ${c.name}, where ${otherPeoplePhrase(Math.max(c.memberCount - 1, 0))}. Make someone else an administrator under Settings → Team, then try again.`
  }
  const perCompany = companies
    .map((c) => `${c.name} (${otherPeoplePhrase(Math.max(c.memberCount - 1, 0))})`)
    .join('; ')
  return `you are the only administrator of ${companies.length} companies — ${perCompany}. Make someone else an administrator in each one under Settings → Team, then try again.`
}

/** One `blocked` company — the common case: a colleague exists to promote. */
function soleAdminBlocked(companyName: string, memberCount: number): string {
  return `Cannot delete account: ${blockedClause([{ name: companyName, memberCount }])}`
}

function soleAdminBlockedMulti(companies: Array<{ name: string; memberCount: number }>): string {
  return `Cannot delete account: ${blockedClause(companies)}`
}

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
  /**
   * companies/{cid}/equipment docs, each optionally carrying its own `units`
   * subcollection docs. Exercises the issue #347 fix — the unfiltered
   * `equipmentRef.get()` walk that replaced the broken
   * `collectionGroup('units').where('companyId', ...)` query, which threw
   * FAILED_PRECONDITION in every environment because no COLLECTION_GROUP_ASC
   * index on `companyId` ever existed.
   */
  equipment?: Array<{ id: string; units?: QueryDocInput[] }>
  /** companies/{cid}.stripeCustomerId, for the Stripe billing-contact block. */
  stripeCustomerId?: string
  /** companies/{cid}.subscription — only `status` matters to that block. */
  subscription?: { status?: string }
  /** companies/{cid}.deletion — issue #383's refusal guard. */
  deletion?: Record<string, unknown>
}

interface Scenario {
  memberships: Array<{ companyId: string; role: string }>
  companies?: Record<string, CompanyFixture>
  /** Custom resolver for companies/{cid}/invitations queries. Defaults to empty. */
  invitations?: QueryResolver
  /** Simulates the initial `users/{uid}/memberships` read itself failing. */
  membershipsFetchError?: Error
  /**
   * `users/${UID}.name` — the deleting user's display name, read once by
   * step 3's Stripe block for the name-only-match check. Omit to simulate no
   * `users/{uid}` doc at all (or no `name` field on it).
   */
  userName?: string
}

function wireScenario(scenario: Scenario) {
  const docs: DocMap = {}

  if (scenario.userName !== undefined) {
    docs[`users/${UID}`] = { name: scenario.userName }
  }

  // getVerifiedSession (lib/dal.ts, issue #252 step 5, PR F) now verifies
  // the SESSION's own activeCompanyId company exists before deleteAccount
  // ever runs. stubSession() defaults activeCompanyId to 'company-A', which
  // is unrelated to whatever membership companies a given scenario is
  // exercising below — seed it as existing by default so that entry check
  // never interferes with what these tests actually assert. A scenario that
  // explicitly configures 'company-A' (most already do, as one of the
  // memberships under test) overrides this below.
  docs['companies/company-A'] = { name: 'company-A' }

  for (const [companyId, fixture] of Object.entries(scenario.companies ?? {})) {
    const exists = fixture.exists ?? true
    docs[`companies/${companyId}`] = exists
      ? {
          name: companyId,
          createdBy: fixture.createdBy ?? null,
          ...(fixture.stripeCustomerId ? { stripeCustomerId: fixture.stripeCustomerId } : {}),
          ...(fixture.subscription ? { subscription: fixture.subscription } : {}),
          ...(fixture.deletion ? { deletion: fixture.deletion } : {}),
        }
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

    // Equipment: the unfiltered path-form walk `equipmentRef.get()` performs
    // (issue #347 — see CompanyFixture.equipment's docblock). The filtered
    // createdBy/approverId queries against this same path fall through to
    // the catch-all `[]` below, same as before.
    const equipmentMatch = ctx.path.match(/^companies\/([^/]+)\/equipment$/)
    if (equipmentMatch && ctx.filters.length === 0) {
      const cid = equipmentMatch[1] as string
      const fixture = scenario.companies?.[cid]
      return (fixture?.equipment ?? []).map((eq) => ({
        id: eq.id,
        path: `companies/${cid}/equipment/${eq.id}`,
        data: {},
      }))
    }

    // Equipment units subcollection — companies/{cid}/equipment/{eqId}/units,
    // reached via `eqDoc.ref.collection('units').get()`.
    const unitsMatch = ctx.path.match(/^companies\/([^/]+)\/equipment\/([^/]+)\/units$/)
    if (unitsMatch) {
      const cid = unitsMatch[1] as string
      const eqId = unitsMatch[2] as string
      const eq = scenario.companies?.[cid]?.equipment?.find((e) => e.id === eqId)
      return eq?.units ?? []
    }

    // Bookings/equipment — nothing to anonymise by default in these tests.
    return []
  }

  const wired = wireDb(adminDb as unknown as Record<string, unknown>, {
    docs,
    query,
    collectionGroup: () => [], // memberships/invitations never used collectionGroup; units no longer do either (issue #347 — see equipmentMatch/unitsMatch above)
  })

  const tx = makeTransaction(docs)
  vi.mocked(adminDb.runTransaction).mockImplementation(
    (cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx),
  )

  return { docs, wired, tx }
}

// ── issue #349: per-uid deletion lock ───────────────────────────────────────
//
// `acquireAccountDeletionLock` (actions/account.ts) goes through
// `adminDb.collection('accountDeletionLocks').doc(uid)`, not the `docs`-map
// path `wireDb` wires — its atomicity comes from `DocumentReference.create()`
// rejecting when the doc already exists, which `makeDocRef`'s stub never does
// on its own (see its docblock in __tests__/helpers/firestore.ts). These
// tests need a lock doc ref whose `create`/`get`/`set`/`delete` spies they can
// both script and assert on directly, so they stand up their own ref rather
// than reusing `wireScenario`'s shared `docs` map.

interface LockRefOptions {
  /** Simulates `create()` rejecting — pass `{ code: 6 }` for ALREADY_EXISTS. */
  createError?: { code: number }
  /** `startedAt` (as millis) the existing lock doc reads back, if any. */
  existingStartedAtMs?: number
}

function makeLockRef(opts: LockRefOptions = {}) {
  return {
    path: `accountDeletionLocks/${UID}`,
    id: UID,
    create: opts.createError
      ? vi.fn().mockRejectedValue(Object.assign(new Error('lock already exists'), opts.createError))
      : vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({
      exists: opts.existingStartedAtMs !== undefined,
      data: () =>
        opts.existingStartedAtMs !== undefined
          ? { startedAt: { toMillis: () => opts.existingStartedAtMs } }
          : undefined,
    }),
    set: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  }
}

/**
 * Routes `adminDb.collection('accountDeletionLocks')` to a fixed `lockRef`
 * (so its spies are assertable) while leaving every other collection on
 * `wireScenario`'s own wiring untouched — same "capture the normal
 * implementation, override one path" pattern the "unknown outcome" test
 * below already uses for `adminDb.doc`.
 */
function stubLockCollection(wired: ReturnType<typeof wireScenario>['wired'], lockRef: ReturnType<typeof makeLockRef>) {
  const resolveCollectionNormally = wired.collection.getMockImplementation() as unknown as (path: string) => unknown
  vi.mocked(adminDb.collection).mockImplementation(((path: string) => {
    if (path === 'accountDeletionLocks') {
      return { doc: () => lockRef }
    }
    return resolveCollectionNormally(path)
  }) as unknown as typeof adminDb.collection)
}

/**
 * Stub getVerifiedSession/verifyAuthenticatedSession by controlling what
 * verifySessionCookie returns.
 *
 * `activeCompanyId: null` (as opposed to simply omitting the key) means "no
 * claim at all", mirroring a real companyless session — issue #362's test
 * below needs to distinguish that from the default 'company-A', which `??`
 * can't do if the field is merely left undefined.
 */
function stubSession(overrides?: Partial<{ uid: string; activeCompanyId: string | null; email: string }>) {
  mockCookieGet.mockReturnValue({ value: 'valid-session-token' })
  const activeCompanyId = overrides && 'activeCompanyId' in overrides
    ? overrides.activeCompanyId
    : 'company-A'
  mockVerifySessionCookie.mockResolvedValue({
    uid:            overrides?.uid ?? UID,
    email:          overrides?.email ?? 'user@example.com',
    ...(activeCompanyId !== null ? { activeCompanyId } : {}),
    role:           'admin',
    email_verified: true,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDeleteSession.mockResolvedValue(undefined)
  mockDeleteUser.mockResolvedValue(undefined)
  // Default: no Stripe customer to retrieve/update. Individual Stripe tests
  // override this per case.
  mockStripeRetrieve.mockResolvedValue({ deleted: true })
  mockStripeUpdate.mockResolvedValue({})
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

  // issue #362 (GDPR Art. 17): a companyless user — no `activeCompanyId`
  // claim at all — previously had no way to delete her own account, because
  // `deleteAccount` used `getVerifiedSession()`, which redirects to
  // /no-company the moment the claim is missing. `deleteAccount` now uses
  // `verifyAuthenticatedSession()` instead (same fix `exportUserData`
  // already had), which never looks at `activeCompanyId` at all. This test
  // would fail with a thrown REDIRECT error under the old guard.
  it('allows deletion for a session with no activeCompanyId claim at all (issue #362)', async () => {
    stubSession({ activeCompanyId: null })
    wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: { 'company-A': { memberRole: 'admin', metaCounts: { members: 5, admins: 2 } } },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockDeleteSession).toHaveBeenCalledOnce()
    expect(mockDeleteUser).toHaveBeenCalledOnce()
  })

  // issue #362: exercises verifyAuthenticatedSession's tolerance vs
  // getVerifiedSession's strictness. The session's OWN activeCompanyId
  // ('company-ghost') points at a company that doesn't exist in Firestore at
  // all — under the old `getVerifiedSession()` guard this would redirect to
  // /no-company before any deletion logic ran. `verifyAuthenticatedSession`
  // never checks whether the claimed company exists, so deletion proceeds
  // normally, driven entirely by the user's real `users/{uid}/memberships`
  // (company-A here), which is unrelated to the stale claim.
  it('allows deletion when activeCompanyId points at a company that no longer exists (issue #362)', async () => {
    stubSession({ activeCompanyId: 'company-ghost' })
    wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: { 'company-A': { memberRole: 'admin', metaCounts: { members: 5, admins: 2 } } },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockDeleteSession).toHaveBeenCalledOnce()
    expect(mockDeleteUser).toHaveBeenCalledOnce()
  })

  it("deletes the account AND schedules the company for immediate deletion when the user is its sole member", async () => {
    // members: 1, admins: 1 — the user is the company's only person.
    //
    // This USED to be a block, with a message telling her to open Help &
    // feedback because we couldn't do it automatically. Issue #252 step 5,
    // PR F2 is the "automatically" arriving: the commit loop writes a
    // `companyDeletions/{id}` ledger row with `mode: 'immediate'`, and the
    // `onCompanyDeletionCreated` trigger purges the company from there.
    // The account deletion itself proceeds — it is not blocked by anything.
    stubSession({ activeCompanyId: 'company-A' })
    const { tx } = wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: { 'company-A': { memberRole: 'admin', metaCounts: { members: 1, admins: 1 } } },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockDeleteSession).toHaveBeenCalledOnce()
    expect(mockDeleteUser).toHaveBeenCalledOnce()

    const ledgerWrite = tx.set.mock.calls.find(
      ([ref]) => (ref as DocRefStub).path.startsWith('companyDeletions/'),
    )
    expect(ledgerWrite, 'a companyDeletions ledger row must be written').toBeDefined()
    expect(ledgerWrite![1]).toMatchObject({
      companyId: 'company-A',
      mode: 'immediate',
      state: 'requested',
      requestedByUid: UID,
      attempts: 0,
    })

    // issue #351: `companies/company-A/members/{UID}` is deleted (tx.delete
    // below, same transaction) before the async purge's members phase ever
    // runs, so it can never read her name/email to build
    // formerMemberContacts itself. This ledger row must carry her contact
    // up front, or the purge's finalize phase never queues her
    // `companyDeleted` mail — see memberCleanup.ts's `already_gone`
    // docblock.
    expect((ledgerWrite![1] as { formerMemberContacts?: unknown[] }).formerMemberContacts).toEqual([
      { uid: UID, name: 'user@example.com', email: 'user@example.com', accountStatus: 'already_gone' },
    ])

    // …and the member-visible mirror on the company document, which is what
    // the sweep queries and what `claimRequestedLease` reads.
    const mirrorWrite = tx.update.mock.calls.find(
      ([ref, data]) =>
        (ref as DocRefStub).path === 'companies/company-A' &&
        (data as { deletion?: unknown }).deletion !== undefined,
    )
    expect(mirrorWrite, 'the company document must mirror the deletion').toBeDefined()
    expect((mirrorWrite![1] as { deletion: { mode: string } }).deletion.mode).toBe('immediate')
  })

  it('MUTATION GUARD: a counter that says 0 but a live count that says 3 must NOT delete the company', async () => {
    // The guard fires on `members <= 1`, so ZERO is inside it too — and a
    // counter stuck at 0 is the more alarming drift of the two, since it
    // claims the company has nobody in it at all. The plan's verification
    // list only names "counter says 1, live says 5", and the tests followed
    // the plan; this is the case that was missing.
    //
    // Same pre-flight/transaction split as the test below, and for the same
    // reason: `getDeletionOutcomes` runs its own `confirmSoleMember`, so a
    // shared counter would be caught there and prove nothing about the
    // commit loop's copy.
    stubSession({ activeCompanyId: 'company-A' })

    const liveMembers: QueryDocInput[] = Array.from({ length: 3 }, (_, i) => ({
      id: `member-${i}`,
      path: `companies/company-A/members/member-${i}`,
      data: { role: i === 0 ? 'admin' : 'crew' },
    }))

    const preflightDocs: DocMap = {
      'companies/company-A': { name: 'company-A' },
      'companies/company-A/_meta/memberCounts': { members: 3, admins: 2 },
    }
    const txDocs: DocMap = {
      'companies/company-A': { name: 'company-A' },
      [`companies/company-A/members/${UID}`]: { role: 'admin' },
      'companies/company-A/_meta/memberCounts': { members: 0, admins: 0 },
    }

    const query: QueryResolver = (ctx) => {
      if (ctx.path === `users/${UID}/memberships`) {
        return [{ id: 'm0', path: `users/${UID}/memberships/m0`, data: { companyId: 'company-A', role: 'admin' } }]
      }
      if (ctx.path === 'companies/company-A/members') {
        const roleFilter = filterValue(ctx, 'role')
        return roleFilter
          ? liveMembers.filter((d) => (d.data as { role?: string }).role === roleFilter)
          : liveMembers
      }
      return []
    }

    wireDb(adminDb as unknown as Record<string, unknown>, { docs: preflightDocs, query, collectionGroup: () => [] })
    const tx = makeTransaction(txDocs)
    vi.mocked(adminDb.runTransaction).mockImplementation(
      (cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx),
    )

    const result = await deleteAccount()

    expect(result.error).toBe(soleAdminBlocked('company-A', 3))
    expect(
      tx.set.mock.calls.filter(([ref]) => (ref as DocRefStub).path.startsWith('companyDeletions/')),
    ).toHaveLength(0)
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })

  it('MUTATION GUARD: a counter that says 1 but a live count that says 5 must NOT delete the company', async () => {
    // The single most dangerous calculation in step 5. `_meta/memberCounts`
    // is denormalised and can drift; here it says the user is alone, while
    // the members subcollection actually holds five people. If the commit
    // loop trusted the counter, five people's company would be purged with
    // no window and no undo because one of them deleted her account.
    //
    // `confirmSoleMember(companyId, counterMembers, tx)` — the live aggregate
    // read inside the transaction — is what must win. With live = 5 the
    // company is not `close` at all, and since this user is its only admin it
    // falls through to the ordinary BLOCKED branch instead.
    //
    // Delete the `confirmSoleMember` call in actions/account.ts and this test
    // fails; that is its whole job.
    //
    // Pre-flight and the commit loop are wired against DIFFERENT
    // `_meta/memberCounts` snapshots — the same technique the stale-preflight
    // tests above use — and that separation is load-bearing HERE in
    // particular. `getDeletionOutcomes` runs its own `confirmSoleMember` in
    // the pre-flight, so a single shared stale counter would be caught there
    // and this test would pass without the commit loop's copy existing at
    // all: a guard covered by a different guard is not a tested guard. So
    // pre-flight is given a SAFE snapshot (5 members, 2 admins → 'leave',
    // straight through), and only the transaction sees the stale-LOW counter.
    stubSession({ activeCompanyId: 'company-A' })

    const liveMembers: QueryDocInput[] = Array.from({ length: 5 }, (_, i) => ({
      id: `member-${i}`,
      path: `companies/company-A/members/member-${i}`,
      data: { role: i === 0 ? 'admin' : 'crew' },
    }))

    const preflightDocs: DocMap = {
      'companies/company-A': { name: 'company-A' },
      'companies/company-A/_meta/memberCounts': { members: 5, admins: 2 },
    }
    const txDocs: DocMap = {
      'companies/company-A': { name: 'company-A' },
      [`companies/company-A/members/${UID}`]: { role: 'admin' },
      'companies/company-A/_meta/memberCounts': { members: 1, admins: 1 },
    }

    const query: QueryResolver = (ctx) => {
      if (ctx.path === `users/${UID}/memberships`) {
        return [{ id: 'm0', path: `users/${UID}/memberships/m0`, data: { companyId: 'company-A', role: 'admin' } }]
      }
      // The live aggregate both `confirmSoleMember` calls resolve against.
      if (ctx.path === 'companies/company-A/members') {
        const roleFilter = filterValue(ctx, 'role')
        return roleFilter
          ? liveMembers.filter((d) => (d.data as { role?: string }).role === roleFilter)
          : liveMembers
      }
      return []
    }

    wireDb(adminDb as unknown as Record<string, unknown>, { docs: preflightDocs, query, collectionGroup: () => [] })
    const tx = makeTransaction(txDocs)
    vi.mocked(adminDb.runTransaction).mockImplementation(
      (cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx),
    )

    const result = await deleteAccount()

    // Blocked, from the LIVE headcount (5) — not 'close', and not the
    // counter's 1.
    expect(result.error).toBe(soleAdminBlocked('company-A', 5))
    // The decisive assertion: nothing was scheduled for deletion.
    expect(
      tx.set.mock.calls.filter(([ref]) => (ref as DocRefStub).path.startsWith('companyDeletions/')),
    ).toHaveLength(0)
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })

  it('blocks deletion with the BLOCKED message when the user is the sole admin of a NON-active company, with other members present', async () => {
    // Active company is company-A (2 admins — safe).
    // Non-active company is company-B (1 admin, 3 members total — this user
    // plus two colleagues) — a genuine 'blocked' outcome: promoting one of
    // those colleagues is a real way out.
    stubSession({ activeCompanyId: 'company-A' })
    wireScenario({
      memberships: [
        { companyId: 'company-A', role: 'admin' },
        { companyId: 'company-B', role: 'admin' },
      ],
      companies: {
        'company-A': { memberRole: 'admin', metaCounts: { members: 5, admins: 2 } },
        'company-B': { memberRole: 'admin', metaCounts: { members: 3, admins: 1 } },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBe(soleAdminBlocked('company-B', 3))
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
    expect(mockDeleteSession).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })

  it('mixed case: a BLOCKED company still blocks, and the CLOSE company alongside it is not mentioned as a problem', async () => {
    // company-A: blocked (sole admin, 2 other members — promote one).
    // company-B: close (sole member) — no longer a problem at all as of
    // issue #252 step 5: it would simply be deleted along with the account.
    //
    // So the message names ONLY company-A, and must not carry any trace of
    // the old "we can't do that automatically yet" advice for company-B.
    // Nothing is deleted or scheduled either, because company-A blocks the
    // whole request before the commit loop starts — an all-or-nothing that
    // matters much more now that part of the loop is irreversible.
    stubSession()
    wireScenario({
      memberships: [
        { companyId: 'company-A', role: 'admin' },
        { companyId: 'company-B', role: 'admin' },
      ],
      companies: {
        'company-A': { memberRole: 'admin', metaCounts: { members: 3, admins: 1 } },
        'company-B': { memberRole: 'admin', metaCounts: { members: 1, admins: 1 } },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBe(soleAdminBlocked('company-A', 3))
    expect(result.error).toContain('Make someone else an administrator')
    // The retired clause. Its absence is the point of this assertion: a
    // sole-member company is handled now, not apologised for.
    expect(result.error).not.toContain('Help & feedback')
    expect(result.error).not.toContain('company-B')
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
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

    // The commit loop's own guard builds this from what the transaction
    // itself read (txDocs: members 3), not from the pre-flight's stale
    // snapshot (preflightDocs: members 3, admins 2 — safe) — this is exactly
    // the point of the test, so the expected string uses txDocs's numbers.
    expect(result.error).toBe(soleAdminBlocked('Acme', 3))
    expect(tx.delete).not.toHaveBeenCalled()
  })

  it('commit loop takes the immediate-deletion branch even for a non-admin sole member — the close check does not depend on role', async () => {
    // Contrived on purpose: a company whose only member doc has role
    // 'crew', not 'admin'. This should be unreachable in practice —
    // updateMemberRole (actions/team.ts) refuses to demote a company's last
    // admin — but the commit loop is the AUTHORITATIVE, last-word guard and
    // must not rely on that invariant holding. Before this fix, the guard
    // only ever reached `close`/`blocked` via `role === 'admin' &&
    // counts.admins <= 1`, so a sole member recorded as 'crew' would fall
    // through that branch entirely and the deletion would proceed, silently
    // orphaning the company.
    //
    // Same technique as the "stale pre-flight" race test above: pre-flight
    // and the commit loop are wired against DIFFERENT `_meta/memberCounts`
    // snapshots, so pre-flight sees a SAFE company (2 members, this user
    // 'crew') and lets the request through — the commit loop alone must
    // catch the sole-member state, proving this is its own independent
    // check and not pre-flight's role-independent one (already covered by
    // __tests__/queries/deletionOutcomes.test.ts) doing the work again.
    stubSession()

    const preflightDocs: DocMap = {
      'companies/company-A': { name: 'Acme' },
      'companies/company-A/_meta/memberCounts': { members: 2, admins: 1 },
    }
    const txDocs: DocMap = {
      'companies/company-A': { name: 'Acme' },
      [`companies/company-A/members/${UID}`]: { role: 'crew' },
      'companies/company-A/_meta/memberCounts': { members: 1, admins: 1 },
    }

    const query: QueryResolver = (ctx) =>
      ctx.path === `users/${UID}/memberships`
        ? [{ id: 'm0', path: `users/${UID}/memberships/m0`, data: { companyId: 'company-A', role: 'crew' } }]
        : []

    wireDb(adminDb as unknown as Record<string, unknown>, { docs: preflightDocs, query })
    const tx = makeTransaction(txDocs)
    vi.mocked(adminDb.runTransaction).mockImplementation(
      (cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx),
    )

    const result = await deleteAccount()

    // No error: the company is scheduled for immediate deletion and the
    // account deletion proceeds. What this test still pins is that reaching
    // that branch does NOT depend on `role === 'admin'` — a sole member
    // recorded as 'crew' must be handled identically, because the commit loop
    // is the authoritative guard and must not lean on an invariant enforced
    // in actions/team.ts.
    expect(result.error).toBeUndefined()
    const ledgerWrite = tx.set.mock.calls.find(
      ([ref]) => (ref as DocRefStub).path.startsWith('companyDeletions/'),
    )
    expect(ledgerWrite, 'a crew-role sole member must still schedule the company for deletion').toBeDefined()
    expect(ledgerWrite![1]).toMatchObject({ companyId: 'company-A', mode: 'immediate' })
  })

  it('blocks with a distinct message when a company\'s outcome could not be determined ("unknown", not "blocked")', async () => {
    // company-A's own document reads fine, but its memberCounts read fails —
    // getDeletionOutcomes (lib/queries/deletionOutcomes.ts) reports that as
    // outcome 'unknown', and deleteAccount must show COULD_NOT_VERIFY_ERROR,
    // never the sole-admin message: the user has nothing to promote their
    // way out of here, the system just couldn't tell.
    stubSession()
    const { wired } = wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: { 'company-A': { memberRole: 'admin', metaCounts: { members: 5, admins: 2 } } },
    })

    // Every OTHER doc path still resolves through wireScenario's normal
    // wiring; only the memberCounts read for this one company is made to
    // fail, so this test isolates that single read's failure mode.
    const resolveDocNormally = wired.doc.getMockImplementation() as unknown as (path: string) => DocRefStub
    vi.mocked(adminDb.doc).mockImplementation(((path: string) => {
      if (path === 'companies/company-A/_meta/memberCounts') {
        return {
          path,
          id: 'memberCounts',
          get: async () => { throw new Error('Firestore unavailable') },
        }
      }
      return resolveDocNormally(path)
    }) as unknown as typeof adminDb.doc)

    const result = await deleteAccount()

    expect(result.error).toBe(COULD_NOT_VERIFY_ERROR)
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
    expect(mockDeleteSession).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })

  it('names every blocking company when more than one blocks at once', async () => {
    // issue #252 point 1: "a user in several companies at once" must get a
    // comprehensible per-company account, not just the worst single outcome.
    stubSession()
    wireScenario({
      memberships: [
        { companyId: 'company-A', role: 'admin' },
        { companyId: 'company-B', role: 'admin' },
      ],
      companies: {
        'company-A': { memberRole: 'admin', metaCounts: { members: 4, admins: 1 } },
        'company-B': { memberRole: 'admin', metaCounts: { members: 2, admins: 1 } },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBe(
      soleAdminBlockedMulti([
        { name: 'company-A', memberCount: 4 },
        { name: 'company-B', memberCount: 2 },
      ]),
    )
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
  })
})

describe('deleteAccount — issue #349 per-uid deletion lock', () => {
  function scenario() {
    return wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: { 'company-A': { memberRole: 'admin', metaCounts: { members: 5, admins: 2 } } },
    })
  }

  it('rejects a concurrent call while a fresh lock is held, before touching the commit loop', async () => {
    stubSession()
    const { wired } = scenario()
    const lockRef = makeLockRef({ createError: { code: 6 }, existingStartedAtMs: Date.now() })
    stubLockCollection(wired, lockRef)

    const result = await deleteAccount()

    expect(result.error).toBe(ACCOUNT_DELETION_IN_PROGRESS_ERROR)
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
    expect(lockRef.set).not.toHaveBeenCalled()
  })

  it('takes over a lock older than the TTL and proceeds normally', async () => {
    stubSession()
    const { wired } = scenario()
    const staleStartedAt = Date.now() - LOCK_TTL_MS - 1
    const lockRef = makeLockRef({ createError: { code: 6 }, existingStartedAtMs: staleStartedAt })
    stubLockCollection(wired, lockRef)

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(lockRef.set).toHaveBeenCalledOnce()
    expect(mockDeleteUser).toHaveBeenCalledOnce()
    expect(lockRef.delete).toHaveBeenCalledOnce()
  })

  it('acquires and releases the lock around a successful deletion', async () => {
    stubSession()
    const { wired } = scenario()
    const lockRef = makeLockRef()
    stubLockCollection(wired, lockRef)

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(lockRef.create).toHaveBeenCalledOnce()
    expect(lockRef.delete).toHaveBeenCalledOnce()
  })

  it('releases the lock even when the sole-admin guard blocks the deletion', async () => {
    stubSession()
    const { wired } = wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: { 'company-A': { memberRole: 'admin', metaCounts: { members: 4, admins: 1 } } },
    })
    const lockRef = makeLockRef()
    stubLockCollection(wired, lockRef)

    const result = await deleteAccount()

    expect(result.error).toBe(soleAdminBlocked('company-A', 4))
    expect(lockRef.create).toHaveBeenCalledOnce()
    expect(lockRef.delete).toHaveBeenCalledOnce()
  })

  it('reports a lock-acquire failure that is not ALREADY_EXISTS as the usual "could not verify" error', async () => {
    stubSession()
    const { wired } = scenario()
    // code 2 (UNKNOWN) rather than 6 (ALREADY_EXISTS): an unrelated Firestore
    // failure, not evidence of a held lock — must not be reported as "in
    // progress", and must not leave anything to release afterwards.
    const lockRef = makeLockRef({ createError: { code: 2 } })
    stubLockCollection(wired, lockRef)

    const result = await deleteAccount()

    expect(result.error).toBe(COULD_NOT_VERIFY_ERROR)
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
    expect(lockRef.delete).not.toHaveBeenCalled()
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

// ── issue #347: units anonymisation ──────────────────────────────────────────
//
// `anonymizeMemberReferences`'s units step used to be a single-filter
// collectionGroup('units').where('companyId', ...) query. That shape needs a
// COLLECTION_GROUP_ASC index on `companyId` that firestore.indexes.json never
// had, so it threw FAILED_PRECONDITION before ever returning — deterministic
// breakage of GDPR Art. 17 deletion, in every environment, for every user.
// The old fixture wiring for this ('units' — no unit docs to anonymise in
// these tests', `collectionGroup: () => []`) is exactly why: it stubbed the
// broken query's result rather than exercising the code path at all. The fix
// walks equipmentRef.get() and eqDoc.ref.collection('units').get() directly
// (mirrors actions/team.ts's anonymizeMemberReferences), so these tests wire
// equipment/units fixtures instead and assert the walk actually runs.

describe('deleteAccount — units anonymisation (issue #347)', () => {
  const BASE_SCENARIO = {
    memberships: [{ companyId: 'company-A', role: 'crew' }],
    companies: { 'company-A': { memberRole: 'crew', metaCounts: { members: 3, admins: 1 } } },
  } satisfies Scenario

  it('nulls createdBy/updatedBy/deactivatedBy on a unit matching the deleted user, leaves another user\'s fields alone', async () => {
    stubSession()
    const { wired } = wireScenario({
      ...BASE_SCENARIO,
      companies: {
        'company-A': {
          memberRole: 'crew',
          metaCounts: { members: 3, admins: 1 },
          equipment: [
            {
              id: 'eq-1',
              units: [
                {
                  id: 'unit-1',
                  path: 'companies/company-A/equipment/eq-1/units/unit-1',
                  data: { createdBy: UID, updatedBy: UID, deactivatedBy: 'other-user', active: true },
                },
                {
                  id: 'unit-2',
                  path: 'companies/company-A/equipment/eq-1/units/unit-2',
                  data: { createdBy: 'other-user', updatedBy: 'other-user', deactivatedBy: 'other-user', active: true },
                },
              ],
            },
          ],
        },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    // unit-1: createdBy and updatedBy matched the deleted uid — nulled.
    // deactivatedBy belonged to someone else, so it's excluded from the
    // update object entirely (addOp is only called with the fields that
    // changed, not a full nulled-out shape).
    expect(wired.batch.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'unit-1' }),
      { createdBy: null, updatedBy: null },
    )
    // unit-2: nothing on it references the deleted uid — no update at all.
    expect(wired.batch.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'unit-2' }),
      expect.anything(),
    )
  })

  it('anonymises a unit with no `active` field at all — the fix must not depend on it', async () => {
    // The rejected alternative fix queried active==true and active==false
    // separately, which silently skipped any unit doc missing `active`
    // entirely. This locks in that the equipment-subcollection walk has no
    // such dependency: the unit below carries no `active` field whatsoever.
    stubSession()
    const { wired } = wireScenario({
      ...BASE_SCENARIO,
      companies: {
        'company-A': {
          memberRole: 'crew',
          metaCounts: { members: 3, admins: 1 },
          equipment: [
            {
              id: 'eq-2',
              units: [
                {
                  id: 'unit-3',
                  path: 'companies/company-A/equipment/eq-2/units/unit-3',
                  data: { deactivatedBy: UID },
                },
              ],
            },
          ],
        },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(wired.batch.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'unit-3' }),
      { deactivatedBy: null },
    )
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

// ── Interaction with the immediate company purge (issue #252 step 5) ──────────

describe('deleteAccount — companies scheduled for immediate deletion', () => {
  it('MUTATION GUARD: does not anonymise documents the purge is concurrently deleting', async () => {
    // Writing the ledger row starts `runCompanyPurge` through
    // `onCompanyDeletionCreated`, typically within a second — while this
    // function is still running. Every anonymisation write targets a document
    // the purge is deleting, and a WriteBatch update against a document that
    // no longer exists fails the WHOLE batch with NOT_FOUND. That would abort
    // the account deletion halfway: memberships gone, company being purged,
    // Auth record still there, and an error telling her nothing worked.
    //
    // Delete the `immediatelyDeletedCompanyIds.has(companyId)` skip in
    // actions/account.ts and this test fails.
    stubSession({ activeCompanyId: 'company-A' })

    const docs: DocMap = {
      'companies/company-A': { name: 'Solo AB', createdBy: UID },
      [`companies/company-A/members/${UID}`]: { role: 'admin', name: 'Solo', email: 'solo@example.com' },
      'companies/company-A/_meta/memberCounts': { members: 1, admins: 1 },
    }

    const query: QueryResolver = (ctx) => {
      if (ctx.path === `users/${UID}/memberships`) {
        return [{ id: 'm0', path: `users/${UID}/memberships/m0`, data: { companyId: 'company-A', role: 'admin' } }]
      }
      // A booking this user authored. If the skip is removed, the
      // anonymisation loop finds it and batches an update against a document
      // the purge is deleting.
      if (ctx.path === 'companies/company-A/bookings') {
        return [{ id: 'b1', path: 'companies/company-A/bookings/b1', data: { userId: UID } }]
      }
      return []
    }

    const wired = wireDb(adminDb as unknown as Record<string, unknown>, {
      docs,
      query,
      collectionGroup: () => [],
    })
    const tx = makeTransaction(docs)
    vi.mocked(adminDb.runTransaction).mockImplementation(
      (cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx),
    )

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    // The company IS scheduled for deletion…
    expect(tx.set.mock.calls.some(([ref]) => (ref as DocRefStub).path.startsWith('companyDeletions/'))).toBe(true)
    // …and nothing under it was queued for anonymisation.
    const touchedPaths = wired.batch.update.mock.calls.map(([ref]) => (ref as DocRefStub).path)
    expect(touchedPaths).not.toContain('companies/company-A/bookings/b1')
    expect(touchedPaths).not.toContain('companies/company-A')
  })

  it('MUTATION GUARD: processes reversible companies BEFORE any irreversible one', async () => {
    // Ordering only — the authoritative decision is still per company, live,
    // inside each transaction. What it buys: if a reversible company's
    // transaction fails transiently, the loop bails out with an error before
    // any company has been torn down. With the memberships listed
    // close-company-first, an unordered loop would schedule the destruction
    // first and only then find out whether the rest of the run works.
    stubSession({ activeCompanyId: 'company-A' })
    const { tx } = wireScenario({
      memberships: [
        { companyId: 'company-close', role: 'admin' },
        { companyId: 'company-A', role: 'admin' },
      ],
      companies: {
        'company-close': { memberRole: 'admin', metaCounts: { members: 1, admins: 1 } },
        'company-A': { memberRole: 'admin', metaCounts: { members: 5, admins: 2 } },
      },
    })

    await deleteAccount()

    const ledgerSet = tx.set.mock.calls.findIndex(([ref]) =>
      (ref as DocRefStub).path.startsWith('companyDeletions/'),
    )
    const ledgerOrder = tx.set.mock.invocationCallOrder[ledgerSet]!
    const safeDeleteOrder = tx.delete.mock.calls
      .map((call, i) => ({ path: (call[0] as DocRefStub).path, order: tx.delete.mock.invocationCallOrder[i]! }))
      .find((c) => c.path === `companies/company-A/members/${UID}`)!.order

    expect(safeDeleteOrder).toBeLessThan(ledgerOrder)
  })
})

// ── issue #358: durable audit trail for a FAILED deletion ──────────────────
//
// Before this, a failed `runAccountDeletion` left nothing in Firestore at
// all — only a `console.error` line living in App Hosting's 30-day log
// retention, not in Allocate's own data (#347 is the concrete case: every
// user's deletion was silently rejected for a stretch of time with zero
// durable trace of it). These tests pin `writeDeletionFailureAudit`
// (actions/account.ts): a standalone `collection('deletionAuditLog').add()`
// call from each phase's own `catch` block, never the batch/transaction that
// just failed.

/**
 * Routes `adminDb.collection('deletionAuditLog')` to a fixed chain — so its
 * `add` spy is assertable — while leaving every other collection on
 * `wired`'s own wiring untouched. Same "capture the normal implementation,
 * override one path" pattern as `stubLockCollection` above.
 */
function stubAuditLogCollection(wired: ReturnType<typeof wireDb>) {
  const auditChain = { add: vi.fn().mockResolvedValue(undefined), doc: vi.fn(() => ({})) }
  const resolveCollectionNormally = wired.collection.getMockImplementation() as unknown as (path: string) => unknown
  vi.mocked(adminDb.collection).mockImplementation(((path: string) => {
    if (path === 'deletionAuditLog') return auditChain
    return resolveCollectionNormally(path)
  }) as unknown as typeof adminDb.collection)
  return auditChain
}

describe('deleteAccount — issue #358 durable audit trail on failure', () => {
  it('step 2 fails for a non sole-admin reason: writes a failure row via collection().add(), never the batch, with no PII', async () => {
    // Same shape as the "aborts with the partial-removal message" test above
    // (company-A succeeds, company-B fails indeterminately) — reused here
    // specifically to assert on the NEW failure-audit write that test itself
    // doesn't check.
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

    const wired = wireDb(adminDb as unknown as Record<string, unknown>, { docs: docsA, query })
    const auditChain = stubAuditLogCollection(wired)

    let call = 0
    vi.mocked(adminDb.runTransaction).mockImplementation(async (cb: unknown) => {
      call += 1
      if (call === 1) {
        const tx = makeTransaction(docsA)
        return (cb as (tx: unknown) => Promise<unknown>)(tx)
      }
      throw Object.assign(new Error('Simulated transient Firestore failure for company-B — includes a path some@email.example'), { code: 'unavailable' })
    })

    const result = await deleteAccount()

    expect(result.error).toBe(COULD_NOT_VERIFY_ERROR)
    expect(auditChain.add).toHaveBeenCalledOnce()
    const row = auditChain.add.mock.calls[0]![0] as Record<string, unknown>
    expect(row).toMatchObject({
      failedStep: 'membership_removal',
      errorCode: 'unavailable',
      completedCompanies: 1,
      totalCompanies: 2,
      outcome: 'failed',
      triggeredBy: 'user_self',
    })
    expect(row.userIdHash).toEqual(expect.any(String))
    expect(row.userIdHash).not.toContain(UID)
    // No PII: no name/email fields, and the thrown error's own MESSAGE text
    // (which could contain anything, as simulated above) never makes it into
    // the row — only its `code`.
    expect(Object.keys(row)).not.toContain('name')
    expect(Object.keys(row)).not.toContain('email')
    expect(JSON.stringify(row)).not.toContain('some@email.example')
    expect(JSON.stringify(row)).not.toContain('Simulated transient Firestore failure')
  })

  it('step 2 sole-admin refusal: writes NO failure row — a valid refusal, not a failure', async () => {
    // Exact setup as "rejects for real inside the commit loop when the
    // pre-flight read was stale (race)" above — the authoritative,
    // in-transaction sole-admin guard firing for real.
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

    const wired = wireDb(adminDb as unknown as Record<string, unknown>, { docs: preflightDocs, query })
    const auditChain = stubAuditLogCollection(wired)
    const tx = makeTransaction(txDocs)
    vi.mocked(adminDb.runTransaction).mockImplementation(
      (cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx),
    )

    const result = await deleteAccount()

    expect(result.error).toBe(soleAdminBlocked('Acme', 3))
    expect(auditChain.add).not.toHaveBeenCalled()
  })

  it('step 3 anonymisation batch.commit throws: writes a failure row via collection().add(), never through the failed batch', async () => {
    stubSession()
    const { wired } = wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: { 'company-A': { memberRole: 'admin', metaCounts: { members: 5, admins: 2 } } },
    })
    const auditChain = stubAuditLogCollection(wired)
    wired.batch.commit.mockRejectedValueOnce(
      Object.assign(new Error('commit failed'), { code: 'aborted' }),
    )

    const result = await deleteAccount()

    expect(result.error).toBe('Failed to delete account')
    expect(auditChain.add).toHaveBeenCalledOnce()
    const row = auditChain.add.mock.calls[0]![0] as Record<string, unknown>
    expect(row).toMatchObject({
      failedStep: 'anonymisation',
      errorCode: 'aborted',
      completedCompanies: 1,
      totalCompanies: 1,
      outcome: 'failed',
    })
    // Never written via the batch that just failed to commit — only via
    // collection().add() above.
    expect(
      wired.batch.set.mock.calls.some(([, data]) => (data as Record<string, unknown> | undefined)?.outcome === 'failed'),
    ).toBe(false)
    // The batch is never re-committed to smuggle the failure row in after
    // the fact — commit() is called exactly once (the one that failed).
    // Catches a mutant that reacts to the commit failure by retrying commit
    // with the failure row appended to the same batch.
    expect(wired.batch.commit).toHaveBeenCalledTimes(1)
  })

  it('adminAuth.deleteUser throws (step 4): writes a failure row with failedStep "auth_delete"', async () => {
    stubSession()
    const { wired } = wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: { 'company-A': { memberRole: 'admin', metaCounts: { members: 5, admins: 2 } } },
    })
    const auditChain = stubAuditLogCollection(wired)
    mockDeleteUser.mockRejectedValueOnce(
      Object.assign(new Error('auth delete failed'), { code: 'auth/internal-error' }),
    )

    const result = await deleteAccount()

    // Step 4's own catch never surfaces an error to the caller (it only
    // console.errors) — the account deletion still reports success. The
    // failure row is the only durable trace of the gap this leaves: the
    // user doc is gone, the Firebase Auth record is not.
    expect(result.error).toBeUndefined()
    expect(auditChain.add).toHaveBeenCalledOnce()
    const row = auditChain.add.mock.calls[0]![0] as Record<string, unknown>
    expect(row).toMatchObject({
      failedStep: 'auth_delete',
      errorCode: 'auth/internal-error',
      completedCompanies: 1,
      totalCompanies: 1,
      outcome: 'failed',
    })
  })

  it('adminAuth.deleteUser throws auth/user-not-found: treated as success — no failure row', async () => {
    // The stranded-account sweep (functions/src/company/strandedAccountSweep.ts)
    // can delete the same uid's Auth record concurrently, for a stranded
    // user past pendingDeletion.scheduledFor. Finding it already gone here
    // is an expected race outcome, not a failure of this run: the goal (no
    // Auth record left) is already reached.
    stubSession()
    const { wired } = wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: { 'company-A': { memberRole: 'admin', metaCounts: { members: 5, admins: 2 } } },
    })
    const auditChain = stubAuditLogCollection(wired)
    mockDeleteUser.mockRejectedValueOnce(
      Object.assign(new Error('There is no user record corresponding to this identifier'), { code: 'auth/user-not-found' }),
    )

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(auditChain.add).not.toHaveBeenCalled()
  })

  it('the failure-row write itself throwing does not mask the original error', async () => {
    stubSession()

    const docsA: DocMap = {
      'companies/company-A': { name: 'A' },
      [`companies/company-A/members/${UID}`]: { role: 'crew' },
      'companies/company-A/_meta/memberCounts': { members: 3, admins: 1 },
    }
    const query: QueryResolver = (ctx) =>
      ctx.path === `users/${UID}/memberships`
        ? [{ id: 'm0', path: `users/${UID}/memberships/m0`, data: { companyId: 'company-A', role: 'crew' } }]
        : []

    const wired = wireDb(adminDb as unknown as Record<string, unknown>, { docs: docsA, query })
    const auditChain = { add: vi.fn().mockRejectedValue(new Error('deletionAuditLog write also failed')), doc: vi.fn(() => ({})) }
    const resolveCollectionNormally = wired.collection.getMockImplementation() as unknown as (path: string) => unknown
    vi.mocked(adminDb.collection).mockImplementation(((path: string) => {
      if (path === 'deletionAuditLog') return auditChain
      return resolveCollectionNormally(path)
    }) as unknown as typeof adminDb.collection)

    vi.mocked(adminDb.runTransaction).mockImplementation(async () => {
      throw Object.assign(new Error('Simulated transient Firestore failure'), { code: 'unavailable' })
    })

    const result = await deleteAccount()

    // The ORIGINAL error still reaches the caller — the audit write's own
    // failure is swallowed (console.error only, per writeDeletionFailureAudit's
    // own try/catch) and never re-thrown or substituted for a different one.
    expect(result.error).toBe(COULD_NOT_VERIFY_ERROR)
    expect(auditChain.add).toHaveBeenCalledOnce()
  })

  it('errorCode falls back to "unknown" when the thrown error\'s `code` is not a string or number', async () => {
    // A non-primitive `code` (an object, here) is exactly the shape
    // `errorCodeOf` must reject rather than pass through `String()` — the
    // whole point of restricting it to string/number is that an arbitrary
    // object could carry anything, including PII, and `String({...})`
    // would happily stringify it into `errorCode`.
    stubSession()

    const docsA: DocMap = {
      'companies/company-A': { name: 'A' },
      [`companies/company-A/members/${UID}`]: { role: 'crew' },
      'companies/company-A/_meta/memberCounts': { members: 3, admins: 1 },
    }
    const query: QueryResolver = (ctx) =>
      ctx.path === `users/${UID}/memberships`
        ? [{ id: 'm0', path: `users/${UID}/memberships/m0`, data: { companyId: 'company-A', role: 'crew' } }]
        : []

    const wired = wireDb(adminDb as unknown as Record<string, unknown>, { docs: docsA, query })
    const auditChain = stubAuditLogCollection(wired)

    vi.mocked(adminDb.runTransaction).mockImplementation(async () => {
      throw Object.assign(new Error('weird error'), {
        code: { nested: 'object', email: 'someone@example.com' },
      })
    })

    const result = await deleteAccount()

    expect(result.error).toBe(COULD_NOT_VERIFY_ERROR)
    expect(auditChain.add).toHaveBeenCalledOnce()
    const row = auditChain.add.mock.calls[0]![0] as Record<string, unknown>
    expect(row.errorCode).toBe('unknown')
    expect(JSON.stringify(row)).not.toContain('someone@example.com')
  })
})

// ── Stripe billing-contact anonymisation (fix/stripe-anonymise-billing-contact) ─
//
// Step 3's Stripe block used to overwrite the company's Stripe customer with
// 'Deleted User' / 'deleted@allocate.invalid' for EVERY surviving company the
// deleting user belonged to — including a crew member who was never the
// billing contact. It now only touches the customer when the customer's OWN
// email matches the deleting user's (case-insensitively), and on a match it
// sets the company name (never a placeholder) and mails the remaining admins.
//
// `mockStripeRetrieve` defaults to `{ deleted: true }` in the top-level
// `beforeEach` — every test below that wants a live, matching (or
// non-matching) customer overrides it explicitly.

function stripeMailCalls(wired: ReturnType<typeof wireScenario>['wired']) {
  return wired.batch.set.mock.calls.filter(
    ([, data]) => (data as { template?: string } | undefined)?.template === 'billingEmailMissing',
  )
}

function billingUpdateCalls(wired: ReturnType<typeof wireScenario>['wired'], companyId: string) {
  return wired.batch.update.mock.calls.filter(
    ([ref, data]) =>
      (ref as DocRefStub).path === `companies/${companyId}` &&
      Object.keys(data as Record<string, unknown>).some((k) => k.startsWith('billing.')),
  )
}

describe('deleteAccount — Stripe billing-contact anonymisation', () => {
  it('does NOT touch the Stripe customer when its email belongs to someone else (a crew member leaving)', async () => {
    stubSession() // uid=user-1, email=user@example.com, role irrelevant to session
    mockStripeRetrieve.mockResolvedValue({ deleted: false, email: 'someone-else@example.com' })

    const { wired } = wireScenario({
      memberships: [{ companyId: 'company-A', role: 'crew' }],
      companies: {
        'company-A': {
          memberRole: 'crew',
          metaCounts: { members: 3, admins: 1 },
          stripeCustomerId: 'cus_other_owner',
          subscription: { status: 'active' },
          members: [{ id: 'admin-1', data: { role: 'admin', email: 'admin@example.com' } }],
        },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockStripeUpdate).not.toHaveBeenCalled()
    expect(stripeMailCalls(wired)).toHaveLength(0)
    expect(billingUpdateCalls(wired, 'company-A')).toHaveLength(0)
  })

  it('anonymises the Stripe customer on an email match: company name + cleared email, billing flag set, one mail per OTHER admin', async () => {
    stubSession() // email=user@example.com
    mockStripeRetrieve.mockResolvedValue({ deleted: false, email: 'user@example.com' })

    const { wired } = wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: {
        'company-A': {
          memberRole: 'admin',
          metaCounts: { members: 2, admins: 2 },
          stripeCustomerId: 'cus_matching',
          subscription: { status: 'active' },
          members: [
            { id: 'm-uid', data: { role: 'admin', email: 'user@example.com' } },
            { id: 'm-other', data: { role: 'admin', email: 'other-admin@example.com' } },
          ],
        },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockStripeUpdate).toHaveBeenCalledWith('cus_matching', {
      email: '',
      name: 'company-A',
      metadata: { billingEmailRemovedAt: expect.any(String) },
    })

    const billingCalls = billingUpdateCalls(wired, 'company-A')
    expect(billingCalls).toHaveLength(1)
    expect(billingCalls[0]![1]).toMatchObject({
      'billing.emailMissingSince': expect.any(String),
      'billing.lastReminderAt': expect.any(String),
    })

    const mailCalls = stripeMailCalls(wired)
    expect(mailCalls).toHaveLength(1)
    expect(mailCalls[0]![1]).toMatchObject({
      to: 'other-admin@example.com',
      template: 'billingEmailMissing',
      companyId: 'company-A',
      status: 'queued',
      priority: 'normal',
      data: { companyName: 'company-A', isReminder: false, settingsUrl: expect.stringContaining('/settings/subscription') },
    })
    // Nobody mails the deleting user about the account she just deleted.
    expect(mailCalls.some(([, data]) => (data as { to?: string }).to === 'user@example.com')).toBe(false)
  })

  it('a failed customers.update on an email match writes no billing flag and sends no mail, but deletion still succeeds', async () => {
    // The `updateSucceeded` gate in actions/account.ts: setting the flag or
    // mailing admins on a failed Stripe write would tell them to fix a
    // problem Stripe doesn't actually have yet (the old email is still on
    // file), and point them at a portal where nothing looks wrong.
    stubSession() // email=user@example.com
    mockStripeRetrieve.mockResolvedValue({ deleted: false, email: 'user@example.com' })
    mockStripeUpdate.mockRejectedValue(new Error('Stripe write failed'))

    const { wired } = wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: {
        'company-A': {
          memberRole: 'admin',
          metaCounts: { members: 2, admins: 2 },
          stripeCustomerId: 'cus_matching',
          subscription: { status: 'active' },
          members: [
            { id: 'm-uid', data: { role: 'admin', email: 'user@example.com' } },
            { id: 'm-other', data: { role: 'admin', email: 'other-admin@example.com' } },
          ],
        },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockDeleteUser).toHaveBeenCalledOnce()
    expect(mockStripeUpdate).toHaveBeenCalledWith('cus_matching', expect.objectContaining({ email: '' }))
    expect(billingUpdateCalls(wired, 'company-A')).toHaveLength(0)
    expect(stripeMailCalls(wired)).toHaveLength(0)
  })

  it('matches case-insensitively', async () => {
    stubSession() // email=user@example.com
    mockStripeRetrieve.mockResolvedValue({ deleted: false, email: 'User@Example.com' })

    wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: {
        'company-A': {
          memberRole: 'admin',
          metaCounts: { members: 2, admins: 2 },
          stripeCustomerId: 'cus_case',
          subscription: { status: 'active' },
          members: [{ id: 'm-uid', data: { role: 'admin', email: 'user@example.com' } }],
        },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockStripeUpdate).toHaveBeenCalledWith('cus_case', expect.objectContaining({ email: '' }))
  })

  it('leaves a shared address (e.g. finance@) untouched', async () => {
    stubSession() // email=user@example.com
    mockStripeRetrieve.mockResolvedValue({ deleted: false, email: 'finance@example.com' })

    const { wired } = wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: {
        'company-A': {
          memberRole: 'admin',
          metaCounts: { members: 2, admins: 2 },
          stripeCustomerId: 'cus_finance',
          subscription: { status: 'active' },
          members: [{ id: 'm-uid', data: { role: 'admin', email: 'user@example.com' } }],
        },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockStripeUpdate).not.toHaveBeenCalled()
    expect(billingUpdateCalls(wired, 'company-A')).toHaveLength(0)
    expect(stripeMailCalls(wired)).toHaveLength(0)
  })

  // ── Name-only match (GDPR finding) ─────────────────────────────────────────
  //
  // Checkout writes `customer_update: { name: 'auto' }` (actions/subscription.ts),
  // so a Stripe customer's `name` can carry the payer's own personal name
  // even when her email was never the billing contact. A name-only match
  // corrects JUST the name — no email clear, no `billing` flag, no mail —
  // because it says nothing about whether she was actually the billing
  // contact.

  it('name matches but email does not: only the Stripe customer NAME is corrected, nothing else', async () => {
    stubSession() // email=user@example.com
    mockStripeRetrieve.mockResolvedValue({ deleted: false, email: 'finance@example.com', name: 'Jane Doe' })

    const { wired } = wireScenario({
      userName: 'Jane Doe',
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: {
        'company-A': {
          memberRole: 'admin',
          metaCounts: { members: 2, admins: 2 },
          stripeCustomerId: 'cus_name_only',
          subscription: { status: 'active' },
          members: [{ id: 'm-uid', data: { role: 'admin', email: 'user@example.com' } }],
        },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockStripeUpdate).toHaveBeenCalledTimes(1)
    expect(mockStripeUpdate).toHaveBeenCalledWith('cus_name_only', { name: 'company-A' })
    expect(billingUpdateCalls(wired, 'company-A')).toHaveLength(0)
    expect(stripeMailCalls(wired)).toHaveLength(0)
  })

  it('name matches case/whitespace-insensitively (" Jane Doe " vs "jane doe")', async () => {
    stubSession()
    mockStripeRetrieve.mockResolvedValue({ deleted: false, email: 'finance@example.com', name: ' Jane Doe ' })

    wireScenario({
      userName: 'jane doe',
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: {
        'company-A': {
          memberRole: 'admin',
          metaCounts: { members: 2, admins: 2 },
          stripeCustomerId: 'cus_name_ws',
          subscription: { status: 'active' },
        },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockStripeUpdate).toHaveBeenCalledWith('cus_name_ws', { name: 'company-A' })
  })

  it('neither name nor email matches: no Stripe write at all', async () => {
    stubSession()
    mockStripeRetrieve.mockResolvedValue({ deleted: false, email: 'finance@example.com', name: 'Someone Else' })

    wireScenario({
      userName: 'Jane Doe',
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: {
        'company-A': {
          memberRole: 'admin',
          metaCounts: { members: 2, admins: 2 },
          stripeCustomerId: 'cus_neither',
          subscription: { status: 'active' },
        },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockStripeUpdate).not.toHaveBeenCalled()
  })

  it('name matches but the company has no name to fall back to: writes nothing (never a placeholder)', async () => {
    stubSession()
    mockStripeRetrieve.mockResolvedValue({ deleted: false, email: 'finance@example.com', name: 'Jane Doe' })

    const docs: DocMap = {
      'companies/company-A': { name: '', stripeCustomerId: 'cus_no_company_name', subscription: { status: 'active' } },
      [`companies/company-A/members/${UID}`]: { role: 'admin' },
      'companies/company-A/_meta/memberCounts': { members: 2, admins: 2 },
      [`users/${UID}`]: { name: 'Jane Doe' },
    }
    const query: QueryResolver = (ctx) =>
      ctx.path === `users/${UID}/memberships`
        ? [{ id: 'm0', path: `users/${UID}/memberships/m0`, data: { companyId: 'company-A', role: 'admin' } }]
        : []
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })
    const tx = makeTransaction(docs)
    vi.mocked(adminDb.runTransaction).mockImplementation(
      (cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx),
    )

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockStripeUpdate).not.toHaveBeenCalled()
  })

  it('skips a deleted Stripe customer ({ deleted: true }) — no update, deletion still succeeds', async () => {
    stubSession()
    mockStripeRetrieve.mockResolvedValue({ deleted: true })

    wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: {
        'company-A': {
          memberRole: 'admin',
          metaCounts: { members: 2, admins: 2 },
          stripeCustomerId: 'cus_deleted',
          subscription: { status: 'active' },
        },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockDeleteUser).toHaveBeenCalledOnce()
    expect(mockStripeUpdate).not.toHaveBeenCalled()
  })

  it('a Stripe retrieve failure never blocks account deletion', async () => {
    stubSession()
    mockStripeRetrieve.mockRejectedValue(new Error('Stripe unavailable'))

    wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: {
        'company-A': {
          memberRole: 'admin',
          metaCounts: { members: 2, admins: 2 },
          stripeCustomerId: 'cus_unreachable',
          subscription: { status: 'active' },
        },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockDeleteUser).toHaveBeenCalledOnce()
    expect(mockStripeUpdate).not.toHaveBeenCalled()
  })

  it('makes no Stripe calls at all when the company has no stripeCustomerId', async () => {
    stubSession()

    wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: {
        'company-A': { memberRole: 'admin', metaCounts: { members: 2, admins: 2 } },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockStripeRetrieve).not.toHaveBeenCalled()
    expect(mockStripeUpdate).not.toHaveBeenCalled()
  })

  it('clears stripeCustomerId only when the subscription is canceled — kept for missing/trialing/active', async () => {
    async function run(subscription: { status?: string } | undefined) {
      stubSession()
      mockStripeRetrieve.mockResolvedValue({ deleted: true }) // irrelevant to this assertion; no match either way
      const { wired } = wireScenario({
        memberships: [{ companyId: 'company-A', role: 'admin' }],
        companies: {
          'company-A': {
            memberRole: 'admin',
            metaCounts: { members: 2, admins: 2 },
            stripeCustomerId: 'cus_x',
            ...(subscription ? { subscription } : {}),
          },
        },
      })
      const result = await deleteAccount()
      expect(result.error).toBeUndefined()
      return wired.batch.update.mock.calls.some(
        ([ref, data]) =>
          (ref as DocRefStub).path === 'companies/company-A' &&
          (data as Record<string, unknown>)['stripeCustomerId'] === '',
      )
    }

    expect(await run({ status: 'canceled' })).toBe(true)
    // The bug this fix closes: `!subStatus` used to also clear it.
    expect(await run(undefined)).toBe(false)
    expect(await run({ status: 'trialing' })).toBe(false)
    expect(await run({ status: 'active' })).toBe(false)
  })

  it('makes no Stripe calls in step 3 for a sole-member company (handled by the immediate-deletion purge instead)', async () => {
    stubSession({ activeCompanyId: 'company-A' })

    wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: {
        'company-A': {
          memberRole: 'admin',
          metaCounts: { members: 1, admins: 1 },
          stripeCustomerId: 'cus_solo',
          subscription: { status: 'active' },
        },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBeUndefined()
    expect(mockStripeRetrieve).not.toHaveBeenCalled()
    expect(mockStripeUpdate).not.toHaveBeenCalled()
  })
})

// ── issue #383: refuse rather than orphan an existing company deletion ─────
//
// A `close` company (the caller is its only member) can already carry a
// `companies/{cid}.deletion` — a `mode: 'window'` request made earlier, while
// she was still one of several members (`requestCompanyDeletion` or the
// operator action). Before this fix, `deleteAccount`'s sole-member branch
// wrote a SECOND `companyDeletions` ledger row with `mode: 'immediate'` and
// overwrote the mirror on the company doc, orphaning the original ledger row
// and starting a second, competing purge. All three `CompanyDeletionState`
// values ('requested' | 'executing' | 'failed') must refuse — no ledger row,
// no mirror write, no member-doc delete, no counts delta.

/** Mirrors `buildPendingDeletionMessage` in actions/account.ts. */
function pendingDeletionMessage(
  companyName: string,
  state: 'requested' | 'executing' | 'failed',
  scheduledForIso: string,
): string {
  const name = companyName || 'Your company'
  switch (state) {
    case 'requested':
      return `${name} is already scheduled for deletion on ${formatDateFull(scheduledForIso)}. Cancel it in company settings, or wait until it completes, then delete your account.`
    case 'executing':
      return `${name} is being deleted right now. Try again in a few minutes.`
    case 'failed':
      return `Deleting ${name} did not finish. Contact support via Help & feedback before deleting your account.`
  }
}

/** Mirrors `buildPendingDeletionMessage`'s generic/default branch — malformed or missing `state`. */
function genericPendingDeletionMessage(companyName: string): string {
  const name = companyName || 'Your company'
  return `${name} already has a deletion in progress. Contact support via Help & feedback before deleting your account.`
}

describe('deleteAccount — issue #383 refuses when a close company already has a pending deletion', () => {
  const SCHEDULED_FOR = '2026-10-01T00:00:00.000Z'

  function pendingDeletionFixture(state: 'requested' | 'executing' | 'failed') {
    return {
      state,
      requestId: 'req-existing',
      requestedAt: SCHEDULED_FOR,
      requestedByName: 'Someone',
      scheduledFor: SCHEDULED_FOR,
      mode: 'window',
    }
  }

  it.each(['requested', 'executing', 'failed'] as const)(
    'pre-flight: refuses a sole-member company whose deletion state is %s, before any write',
    async (state) => {
      stubSession({ activeCompanyId: 'company-A' })
      const { tx } = wireScenario({
        memberships: [{ companyId: 'company-A', role: 'admin' }],
        companies: {
          'company-A': {
            memberRole: 'admin',
            metaCounts: { members: 1, admins: 1 },
            deletion: pendingDeletionFixture(state),
          },
        },
      })

      const result = await deleteAccount()

      expect(result.error).toBe(pendingDeletionMessage('company-A', state, SCHEDULED_FOR))
      expect(result.error).toContain('company-A')
      if (state === 'requested') expect(result.error).toContain(formatDateFull(SCHEDULED_FOR))

      // The pre-flight refuses before the commit loop even starts.
      expect(adminDb.runTransaction).not.toHaveBeenCalled()
      expect(tx.set).not.toHaveBeenCalled()
      expect(tx.update).not.toHaveBeenCalled()
      expect(tx.delete).not.toHaveBeenCalled()
      expect(mockDeleteUser).not.toHaveBeenCalled()
      expect(mockDeleteSession).not.toHaveBeenCalled()
    },
  )

  it('refuses with the generic message when the deletion field has no state (malformed/unknown), never returning a bare undefined error', async () => {
    // The field EXISTING is what means "a deletion is in progress" (mirrors
    // the sibling guards' `if (existing)` in actions/companyDeletion.ts and
    // actions/operatorCompanyDeletion.ts) — `state` itself may be missing or
    // an unrecognised value on the raw doc, and that must fall through to a
    // safe generic refusal rather than `buildPendingDeletionMessage`
    // returning `undefined` (which would make `runAccountDeletion` return
    // `{ error: undefined }`, indistinguishable from success).
    stubSession({ activeCompanyId: 'company-A' })
    const { tx } = wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: {
        'company-A': {
          memberRole: 'admin',
          metaCounts: { members: 1, admins: 1 },
          deletion: { requestId: 'req-existing', mode: 'window' }, // no `state` at all
        },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBeDefined()
    expect(result.error).toBe(genericPendingDeletionMessage('company-A'))
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
    expect(tx.set).not.toHaveBeenCalled()
    expect(tx.update).not.toHaveBeenCalled()
    expect(tx.delete).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
    expect(mockDeleteSession).not.toHaveBeenCalled()
  })

  it('multi-company: refuses before the loop, so a safe company alongside it never loses its membership either', async () => {
    // company-A: 'leave' — a regular crew member, unaffected either way.
    // company-B: 'close' with a pending window deletion — the one that must
    // refuse. Because the pre-flight check runs before the commit loop, NO
    // membership is deleted in EITHER company, proving the guard fires
    // ahead of the loop rather than only on company-B's own turn (which,
    // per the `close`-last ordering, would come after company-A's removal).
    stubSession()
    const { tx } = wireScenario({
      memberships: [
        { companyId: 'company-A', role: 'crew' },
        { companyId: 'company-B', role: 'admin' },
      ],
      companies: {
        'company-A': { memberRole: 'crew', metaCounts: { members: 3, admins: 2 } },
        'company-B': {
          memberRole: 'admin',
          metaCounts: { members: 1, admins: 1 },
          deletion: pendingDeletionFixture('requested'),
        },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBe(pendingDeletionMessage('company-B', 'requested', SCHEDULED_FOR))
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
    expect(tx.delete).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })

  it('multi-company: names EVERY pending-close company, not just the first, mirroring buildSoleAdminMessage', async () => {
    // Two sole-member companies, each mid-deletion in a different state — a
    // user refused on company-A must not retry, pass company-A, and then be
    // refused again by company-B with no warning it existed too. No
    // transaction runs: the pre-flight refuses before the commit loop.
    stubSession()
    wireScenario({
      memberships: [
        { companyId: 'company-A', role: 'admin' },
        { companyId: 'company-B', role: 'admin' },
      ],
      companies: {
        'company-A': {
          memberRole: 'admin',
          metaCounts: { members: 1, admins: 1 },
          deletion: pendingDeletionFixture('requested'),
        },
        'company-B': {
          memberRole: 'admin',
          metaCounts: { members: 1, admins: 1 },
          deletion: pendingDeletionFixture('executing'),
        },
      },
    })

    const result = await deleteAccount()

    expect(result.error).toBe(
      `${pendingDeletionMessage('company-A', 'requested', SCHEDULED_FOR)} ${pendingDeletionMessage('company-B', 'executing', SCHEDULED_FOR)}`,
    )
    expect(result.error).toContain('company-A')
    expect(result.error).toContain('company-B')
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })

  it('authoritative: refuses with the generic message when the pre-flight missed a malformed deletion (no state), writing no ledger, mirror, member delete, or audit row', async () => {
    // Same split-snapshot technique as the test below — pre-flight's read
    // has no `deletion` field at all, and only the transaction's own read
    // carries it, this time with no `state` on it (malformed data). Proves
    // the authoritative guard's `if (existingDeletion)` (field presence, not
    // `.state`) actually fires on the transaction's own read, not just on
    // the pre-flight's typed `pendingDeletion`.
    stubSession({ activeCompanyId: 'company-A' })

    const preflightDocs: DocMap = {
      'companies/company-A': { name: 'company-A' },
      'companies/company-A/_meta/memberCounts': { members: 1, admins: 1 },
    }
    const txDocs: DocMap = {
      'companies/company-A': { name: 'company-A', deletion: { requestId: 'req-existing', mode: 'window' } },
      [`companies/company-A/members/${UID}`]: { role: 'admin' },
      'companies/company-A/_meta/memberCounts': { members: 1, admins: 1 },
    }

    const query: QueryResolver = (ctx) => {
      if (ctx.path === `users/${UID}/memberships`) {
        return [{ id: 'm0', path: `users/${UID}/memberships/m0`, data: { companyId: 'company-A', role: 'admin' } }]
      }
      if (ctx.path === 'companies/company-A/members') {
        return [{ id: UID, path: `companies/company-A/members/${UID}`, data: { role: 'admin' } }]
      }
      return []
    }

    const wired = wireDb(adminDb as unknown as Record<string, unknown>, { docs: preflightDocs, query, collectionGroup: () => [] })
    const auditChain = stubAuditLogCollection(wired)
    const tx = makeTransaction(txDocs)
    vi.mocked(adminDb.runTransaction).mockImplementation(
      (cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx),
    )

    const result = await deleteAccount()

    expect(result.error).toBe(genericPendingDeletionMessage('company-A'))
    expect(
      tx.set.mock.calls.filter(([ref]) => (ref as DocRefStub).path.startsWith('companyDeletions/')),
    ).toHaveLength(0)
    expect(
      tx.update.mock.calls.filter(
        ([ref, data]) =>
          (ref as DocRefStub).path === 'companies/company-A' && (data as { deletion?: unknown }).deletion !== undefined,
      ),
    ).toHaveLength(0)
    expect(tx.delete).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
    expect(auditChain.add).not.toHaveBeenCalled()
  })

  it('authoritative: refuses even when the pre-flight read missed the deletion (race), writing no ledger, mirror, or failure-audit row', async () => {
    // Same "pre-flight sees one snapshot, the transaction's own read sees a
    // different one" technique as the MUTATION GUARD tests above — here the
    // pre-flight's company read has no `deletion` field at all (as if the
    // window request landed in the gap between the pre-flight read and the
    // commit loop's own read), and only the transaction's read carries it.
    stubSession({ activeCompanyId: 'company-A' })

    const preflightDocs: DocMap = {
      'companies/company-A': { name: 'company-A' },
      'companies/company-A/_meta/memberCounts': { members: 1, admins: 1 },
    }
    const txDocs: DocMap = {
      'companies/company-A': { name: 'company-A', deletion: pendingDeletionFixture('requested') },
      [`companies/company-A/members/${UID}`]: { role: 'admin' },
      'companies/company-A/_meta/memberCounts': { members: 1, admins: 1 },
    }

    const query: QueryResolver = (ctx) => {
      if (ctx.path === `users/${UID}/memberships`) {
        return [{ id: 'm0', path: `users/${UID}/memberships/m0`, data: { companyId: 'company-A', role: 'admin' } }]
      }
      if (ctx.path === 'companies/company-A/members') {
        return [{ id: UID, path: `companies/company-A/members/${UID}`, data: { role: 'admin' } }]
      }
      return []
    }

    const wired = wireDb(adminDb as unknown as Record<string, unknown>, { docs: preflightDocs, query, collectionGroup: () => [] })
    const auditChain = stubAuditLogCollection(wired)
    const tx = makeTransaction(txDocs)
    vi.mocked(adminDb.runTransaction).mockImplementation(
      (cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx),
    )

    const result = await deleteAccount()

    expect(result.error).toBe(pendingDeletionMessage('company-A', 'requested', SCHEDULED_FOR))
    expect(
      tx.set.mock.calls.filter(([ref]) => (ref as DocRefStub).path.startsWith('companyDeletions/')),
    ).toHaveLength(0)
    expect(
      tx.update.mock.calls.filter(
        ([ref, data]) =>
          (ref as DocRefStub).path === 'companies/company-A' && (data as { deletion?: unknown }).deletion !== undefined,
      ),
    ).toHaveLength(0)
    expect(tx.delete).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
    // A refusal, not a failure — same reasoning as the 'sole-admin' refusal
    // test in the issue #358 block above.
    expect(auditChain.add).not.toHaveBeenCalled()
  })
})
