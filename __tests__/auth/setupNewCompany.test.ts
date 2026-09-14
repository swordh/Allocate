/**
 * Tests that a new company is born with a complete stats map.
 *
 * lastBookingAt must be written as an explicit null rather than omitted.
 * Firestore excludes documents that LACK a field from inequality queries, so a
 * company without the key would never appear in the operator's "No bookings 30 d"
 * segment — silently, with no error. Present-and-null sorts before timestamps and
 * is included.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {
    doc: vi.fn(),
    collection: vi.fn(),
    batch: vi.fn(),
  },
  adminAuth: {
    verifyIdToken: vi.fn(),
    setCustomUserClaims: vi.fn(),
    getUser: vi.fn(),
  },
}))

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: vi.fn(),
  // Only consulted per orphan-skip membership found by the idempotency
  // probe below — the default `wire()` setup has none, so this stub is
  // never actually called in the "writes a complete stats map" tests. The
  // idempotency-specific tests further down override it.
  getCompanyDoc: vi.fn(),
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { setupNewCompany } from '@/actions/auth'
import { adminDb, adminAuth } from '@/lib/firebase-admin'
import { getCompanyDoc } from '@/lib/dal'

const UID = 'user-1'
const NEW_COMPANY_ID = 'company-new'

/**
 * @param memberships - existing `users/{uid}/memberships` docs the
 *   idempotency probe should see. Defaults to none (brand-new user).
 * @param userExists - whether `users/{uid}` already exists. Defaults to
 *   false (brand-new user) — a returning user (stranded former member,
 *   PR F) takes the `merge: true` branch instead of the full `batch.set`.
 * @param claims - the custom claims currently on the Auth user, as
 *   `adminAuth.getUser` reports them. Defaults to none, i.e. the broken
 *   post-`setCustomUserClaims`-failure state the repair branch exists for.
 * @param companyMembers - `companies/{cid}/members/{uid}` docs, keyed by
 *   company id, with the role the repair branch must read live rather than
 *   assume. `exists: false` models a snapshot that reports non-existence
 *   while still carrying data — Firestore never returns that shape, but it
 *   is what isolates the `memberSnap.exists` check from the role check
 *   behind it, so each can be mutation-tested on its own.
 */
function wire(opts: {
  memberships?: Array<{ companyId: string }>
  userExists?: boolean
  claims?: Record<string, unknown>
  companyMembers?: Record<string, { role?: string; exists?: boolean }>
} = {}) {
  const memberships = opts.memberships ?? []
  const userExists = opts.userExists ?? false
  const companyMembers = opts.companyMembers ?? {}
  const batch = { set: vi.fn(), commit: vi.fn().mockResolvedValue(undefined) }

  vi.mocked(adminAuth.verifyIdToken).mockResolvedValue({
    uid: UID,
    email: 'owner@example.com',
  } as never)
  vi.mocked(adminAuth.setCustomUserClaims).mockResolvedValue(undefined as never)
  vi.mocked(adminAuth.getUser).mockResolvedValue({
    uid: UID,
    customClaims: opts.claims,
  } as never)

  vi.mocked(adminDb.collection).mockImplementation((path: string) => ({
    path,
    // Idempotency probe: `users/{uid}/memberships`.
    get: vi.fn().mockResolvedValue({
      docs: memberships.map((m) => ({ data: () => m })),
    }),
    doc: vi.fn().mockReturnValue({ id: NEW_COMPANY_ID, path: `${path}/${NEW_COMPANY_ID}` }),
  } as never))

  vi.mocked(adminDb.doc).mockImplementation((path: string) => {
    const memberMatch = /^companies\/(.+)\/members\/(.+)$/.exec(path)
    const memberEntry = memberMatch && memberMatch[2] === UID
      ? companyMembers[memberMatch[1]]
      : undefined
    const exists = memberMatch
      ? memberEntry !== undefined && memberEntry.exists !== false
      : path === `users/${UID}` && userExists
    const data = memberEntry

    return {
      path,
      id: path.split('/').pop(),
      get: vi.fn().mockResolvedValue({ exists, data: () => data }),
    } as never
  })

  vi.mocked(adminDb.batch).mockReturnValue(batch as never)

  return { batch }
}

/** A live company document snapshot, as `getCompanyDoc` returns it. */
function liveCompany(createdBy?: string) {
  return { exists: true, data: () => ({ createdBy }) } as never
}

const DEAD_COMPANY = { exists: false, data: () => undefined } as never

describe('setupNewCompany — initial stats map', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes a complete stats map with lastBookingAt present and null', async () => {
    const { batch } = wire()

    await setupNewCompany('id-token', 'Nordfilm AB', 'Owner', 'Europe/Stockholm')

    // The company document is the first thing the batch writes.
    const [, companyDoc] = batch.set.mock.calls[0]
    const payload = companyDoc as Record<string, unknown>
    expect(payload.name).toBe('Nordfilm AB')

    const stats = payload.stats as Record<string, unknown>
    expect(stats.equipmentCount).toBe(0)
    expect(stats.bookingsCreated).toBe(0)
    expect(stats.bookingsCancelled).toBe(0)

    // Present AND null — not merely falsy, and not absent.
    expect('lastBookingAt' in stats).toBe(true)
    expect(stats.lastBookingAt).toBeNull()
  })

  it('writes memberCount: 1 for the founder — not folded into INITIAL_COMPANY_STATS', async () => {
    const { batch } = wire()

    await setupNewCompany('id-token', 'Nordfilm AB', 'Owner', 'Europe/Stockholm')

    const [, companyDoc] = batch.set.mock.calls[0]
    const stats = (companyDoc as Record<string, unknown>).stats as Record<string, unknown>

    // The company is never observed with zero members: the founder's own
    // companies/{id}/members/{uid} doc is written in the same batch.
    expect(stats.memberCount).toBe(1)
  })

  it('seeds _meta/memberCounts with { members: 1, admins: 1 } for the founder', async () => {
    const { batch } = wire()

    await setupNewCompany('id-token', 'Nordfilm AB', 'Owner', 'Europe/Stockholm')

    // The founder's company must never be observed without its
    // member-counts counter (lib/companyStats.ts readMemberCounts) — same
    // reasoning as seeding _meta/equipmentCount above it in actions/auth.ts,
    // so readMemberCounts's self-heal fallback never has to run for a
    // company created through this path.
    const memberCountsCall = batch.set.mock.calls.find(
      (call) => (call[0] as { path?: string }).path === `companies/${NEW_COMPANY_ID}/_meta/memberCounts`,
    )
    expect(memberCountsCall).toBeDefined()
    const [, memberCountsDoc] = memberCountsCall!
    expect(memberCountsDoc).toMatchObject({ members: 1, admins: 1 })
  })
})

/**
 * Issue #252 step 5, PR F: `setupNewCompany` used to throw `already-exists`
 * as soon as ANY membership doc existed, regardless of whether the company
 * behind it still did. A membership pointing at a deleted company (left
 * behind by the #252 purge, PR E) permanently locked that user out — the
 * exact return path the plan calls out as "en ny återvändsgränd av exakt
 * den sort #252 finns för att ta bort".
 */
describe('setupNewCompany — idempotency probe skips orphaned memberships', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('proceeds when the only membership points at a company that no longer exists', async () => {
    const { batch } = wire({ memberships: [{ companyId: 'ghost-co' }] })
    vi.mocked(getCompanyDoc).mockResolvedValue(DEAD_COMPANY)

    await expect(
      setupNewCompany('id-token', 'Nordfilm AB', 'Owner', 'Europe/Stockholm'),
    ).resolves.toBeUndefined()

    expect(getCompanyDoc).toHaveBeenCalledWith('ghost-co')
    expect(batch.commit).toHaveBeenCalled()
  })

  // Mutation check for the skip above: with the same shape of input but the
  // company reported as EXISTING, the guard must still fire — proves the
  // `.some(Boolean)` check isn't accidentally always true or always false.
  it('still throws already-exists when the membership points at a company that exists', async () => {
    // Founded by someone else — she was invited into it, so the repair
    // branch must not fire and the refusal must stand.
    const { batch } = wire({ memberships: [{ companyId: 'live-co' }] })
    vi.mocked(getCompanyDoc).mockResolvedValue(liveCompany('someone-else'))

    await expect(
      setupNewCompany('id-token', 'Nordfilm AB', 'Owner', 'Europe/Stockholm'),
    ).rejects.toThrow('already-exists')

    // No partial write: the guard fires before any batch op is queued.
    expect(batch.set).not.toHaveBeenCalled()
    expect(batch.commit).not.toHaveBeenCalled()
  })

  it('throws already-exists when at least one of several memberships points at a live company', async () => {
    const { batch } = wire({
      memberships: [{ companyId: 'ghost-co' }, { companyId: 'live-co' }],
    })
    vi.mocked(getCompanyDoc).mockImplementation(
      (companyId: string) =>
        Promise.resolve(companyId === 'live-co' ? liveCompany('someone-else') : DEAD_COMPANY) as never,
    )

    await expect(
      setupNewCompany('id-token', 'Nordfilm AB', 'Owner', 'Europe/Stockholm'),
    ).rejects.toThrow('already-exists')
    expect(batch.commit).not.toHaveBeenCalled()
  })
})

/**
 * Issue #252 step 5, PR F, "Avbrottsvillkoret": creating a company for a
 * returning user must clear `users/{uid}.pendingDeletion` (types/user.ts)
 * in the SAME batch as the new membership write, and must not reset
 * `createdAt` or otherwise stomp her existing user document.
 */
describe('setupNewCompany — cancels a scheduled account deletion for a returning user', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('merges pendingDeletion: FieldValue.delete() into the user doc instead of overwriting it', async () => {
    const { batch } = wire({ userExists: true })

    await setupNewCompany('id-token', 'Nordfilm AB', 'Owner', 'Europe/Stockholm')

    const userCall = batch.set.mock.calls.find(
      (call) => (call[0] as { path?: string }).path === `users/${UID}`,
    )
    expect(userCall).toBeDefined()
    const [, payload, options] = userCall!

    // Same write, same batch as the membership doc below it — not a
    // follow-up call that could be skipped on a partial failure.
    expect(options).toEqual({ merge: true })
    expect('pendingDeletion' in (payload as Record<string, unknown>)).toBe(true)
    // Must NOT reset her original account creation date.
    expect('createdAt' in (payload as Record<string, unknown>)).toBe(false)
  })

  // Mutation check: a brand-new user (the ordinary signup path) must take
  // the OTHER branch — a full create with createdAt, no merge option — so
  // this test fails if the userExists branch is accidentally used for
  // everyone.
  it('does a plain create with createdAt for a brand-new user, not a merge', async () => {
    const { batch } = wire({ userExists: false })

    await setupNewCompany('id-token', 'Nordfilm AB', 'Owner', 'Europe/Stockholm')

    const userCall = batch.set.mock.calls.find(
      (call) => (call[0] as { path?: string }).path === `users/${UID}`,
    )
    expect(userCall).toBeDefined()
    const [, payload, options] = userCall!

    expect(options).toBeUndefined()
    expect('createdAt' in (payload as Record<string, unknown>)).toBe(true)
    expect('pendingDeletion' in (payload as Record<string, unknown>)).toBe(false)
  })
})

/**
 * Issue #252 step 5, PR F: `setupNewCompany` commits its batch and only then
 * calls `setCustomUserClaims`. If that second step fails, the company and
 * both membership docs exist while the Auth user has no `activeCompanyId`
 * claim — `getVerifiedSession` sends her to /no-company, and every retry
 * from there used to hit the "live company" branch and throw
 * `already-exists` forever. For a stranded former member that dead end has a
 * thirty-day clock on it (types/user.ts `PendingAccountDeletion`), which is
 * worse than the dead end #252 exists to close.
 *
 * The repair writes custom claims, so what counts as "hers" is the security
 * question these tests exist to pin: founded by her (`createdBy`), still a
 * member of it right now, and the role taken live off the member document —
 * all three from documents firestore.rules makes server-write-only.
 */
describe('setupNewCompany — repairs claims for a company she founded but cannot reach', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function wireFounded(opts: { claims?: Record<string, unknown>; role?: string } = {}) {
    const wired = wire({
      memberships: [{ companyId: 'my-co' }],
      claims: opts.claims,
      companyMembers: { 'my-co': { role: opts.role ?? 'admin' } },
    })
    vi.mocked(getCompanyDoc).mockResolvedValue(liveCompany(UID))
    return wired
  }

  it('sets claims to the founded company instead of throwing, and creates nothing', async () => {
    const { batch } = wireFounded()

    await expect(
      setupNewCompany('id-token', 'Nordfilm AB', 'Owner', 'Europe/Stockholm'),
    ).resolves.toBeUndefined()

    expect(adminAuth.setCustomUserClaims).toHaveBeenCalledWith(UID, {
      activeCompanyId: 'my-co',
      role: 'admin',
    })
    // A repair, not a second company.
    expect(batch.set).not.toHaveBeenCalled()
    expect(batch.commit).not.toHaveBeenCalled()
  })

  it('takes the role from the live member document, never assuming admin', async () => {
    wireFounded({ role: 'crew' })

    await setupNewCompany('id-token', 'Nordfilm AB', 'Owner', 'Europe/Stockholm')

    // She founded it but has since been demoted. The claims must say what
    // the member document says, or this branch becomes a way to promote
    // yourself by retrying signup.
    expect(adminAuth.setCustomUserClaims).toHaveBeenCalledWith(UID, {
      activeCompanyId: 'my-co',
      role: 'crew',
    })
  })

  it('leaves working claims alone and still refuses — nothing is broken there', async () => {
    wireFounded({ claims: { activeCompanyId: 'my-co', role: 'admin' } })

    await expect(
      setupNewCompany('id-token', 'Nordfilm AB', 'Owner', 'Europe/Stockholm'),
    ).rejects.toThrow('already-exists')

    expect(adminAuth.setCustomUserClaims).not.toHaveBeenCalled()
  })

  it('repairs claims that point at a company that no longer exists', async () => {
    // Her token still names the purged company. That is the same stranded
    // state, reached from the other side.
    wireFounded({ claims: { activeCompanyId: 'purged-co', role: 'admin' } })

    await setupNewCompany('id-token', 'Nordfilm AB', 'Owner', 'Europe/Stockholm')

    expect(adminAuth.setCustomUserClaims).toHaveBeenCalledWith(UID, {
      activeCompanyId: 'my-co',
      role: 'admin',
    })
  })

  it('refuses when the Auth lookup fails — cannot prove the claims are broken', async () => {
    wireFounded()
    vi.mocked(adminAuth.getUser).mockRejectedValue(new Error('auth down') as never)

    await expect(
      setupNewCompany('id-token', 'Nordfilm AB', 'Owner', 'Europe/Stockholm'),
    ).rejects.toThrow('already-exists')

    expect(adminAuth.setCustomUserClaims).not.toHaveBeenCalled()
  })
})

/**
 * The negative case the repair branch must never swallow: a live company
 * that is NOT hers. If founding were not required — if a bare membership doc
 * or the client's own token were enough — this branch would be a way to
 * point your claims at a company you merely appear in, or one you can name.
 */
describe('setupNewCompany — refuses to repair claims against a company that is not hers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws already-exists for a live company founded by someone else, even with no claims at all', async () => {
    const { batch } = wire({
      memberships: [{ companyId: 'someone-elses-co' }],
      claims: undefined, // the "broken claims" state — must not be enough on its own
      companyMembers: { 'someone-elses-co': { role: 'admin' } },
    })
    vi.mocked(getCompanyDoc).mockResolvedValue(liveCompany('another-founder'))

    await expect(
      setupNewCompany('id-token', 'Nordfilm AB', 'Owner', 'Europe/Stockholm'),
    ).rejects.toThrow('already-exists')

    // The load-bearing assertion: NO claims were written against a company
    // she did not create. Membership plus missing claims must not be a
    // claims-granting oracle.
    expect(adminAuth.setCustomUserClaims).not.toHaveBeenCalled()
    expect(batch.commit).not.toHaveBeenCalled()
  })

  it('refuses when the company document carries no createdBy at all', async () => {
    wire({
      memberships: [{ companyId: 'legacy-co' }],
      companyMembers: { 'legacy-co': { role: 'admin' } },
    })
    vi.mocked(getCompanyDoc).mockResolvedValue(liveCompany(undefined))

    await expect(
      setupNewCompany('id-token', 'Nordfilm AB', 'Owner', 'Europe/Stockholm'),
    ).rejects.toThrow('already-exists')

    // `createdBy === uid` must not degrade to `undefined === undefined` or
    // to a truthiness check for a document predating the field.
    expect(adminAuth.setCustomUserClaims).not.toHaveBeenCalled()
  })

  it('refuses when she founded it but is no longer a member of it', async () => {
    wire({
      memberships: [{ companyId: 'my-old-co' }],
      companyMembers: {}, // companies/my-old-co/members/{uid} is gone
    })
    vi.mocked(getCompanyDoc).mockResolvedValue(liveCompany(UID))

    await expect(
      setupNewCompany('id-token', 'Nordfilm AB', 'Owner', 'Europe/Stockholm'),
    ).rejects.toThrow('already-exists')

    // Founding it once is not standing membership. A founder who was removed
    // from her own company must not be readmitted by a signup retry.
    expect(adminAuth.setCustomUserClaims).not.toHaveBeenCalled()
  })

  // Mutation isolation for `if (!memberSnap.exists) return false`: the
  // snapshot reports non-existence but still carries a perfectly valid role,
  // so the role whitelist behind it cannot be what rejects this. Drop the
  // exists check and this is the test that fails.
  it('refuses on a non-existent member document even when it carries a valid role', async () => {
    wire({
      memberships: [{ companyId: 'my-co' }],
      companyMembers: { 'my-co': { role: 'admin', exists: false } },
    })
    vi.mocked(getCompanyDoc).mockResolvedValue(liveCompany(UID))

    await expect(
      setupNewCompany('id-token', 'Nordfilm AB', 'Owner', 'Europe/Stockholm'),
    ).rejects.toThrow('already-exists')

    expect(adminAuth.setCustomUserClaims).not.toHaveBeenCalled()
  })

  it('refuses when the member document carries no usable role', async () => {
    wire({
      memberships: [{ companyId: 'my-co' }],
      companyMembers: { 'my-co': { role: 'superuser' } },
    })
    vi.mocked(getCompanyDoc).mockResolvedValue(liveCompany(UID))

    await expect(
      setupNewCompany('id-token', 'Nordfilm AB', 'Owner', 'Europe/Stockholm'),
    ).rejects.toThrow('already-exists')

    // Never write a role into claims that isn't one of the three the app
    // knows (types/user.ts `Role`).
    expect(adminAuth.setCustomUserClaims).not.toHaveBeenCalled()
  })

  it('repairs only the founded company when she is also a member of someone else’s', async () => {
    wire({
      memberships: [{ companyId: 'someone-elses-co' }, { companyId: 'my-co' }],
      companyMembers: { 'someone-elses-co': { role: 'crew' }, 'my-co': { role: 'admin' } },
    })
    vi.mocked(getCompanyDoc).mockImplementation(
      (companyId: string) =>
        Promise.resolve(liveCompany(companyId === 'my-co' ? UID : 'another-founder')) as never,
    )

    await setupNewCompany('id-token', 'Nordfilm AB', 'Owner', 'Europe/Stockholm')

    expect(adminAuth.setCustomUserClaims).toHaveBeenCalledWith(UID, {
      activeCompanyId: 'my-co',
      role: 'admin',
    })
  })
})
