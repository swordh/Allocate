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
 */
function wire(opts: { memberships?: Array<{ companyId: string }>; userExists?: boolean } = {}) {
  const memberships = opts.memberships ?? []
  const userExists = opts.userExists ?? false
  const batch = { set: vi.fn(), commit: vi.fn().mockResolvedValue(undefined) }

  vi.mocked(adminAuth.verifyIdToken).mockResolvedValue({
    uid: UID,
    email: 'owner@example.com',
  } as never)
  vi.mocked(adminAuth.setCustomUserClaims).mockResolvedValue(undefined as never)

  vi.mocked(adminDb.collection).mockImplementation((path: string) => ({
    path,
    // Idempotency probe: `users/{uid}/memberships`.
    get: vi.fn().mockResolvedValue({
      docs: memberships.map((m) => ({ data: () => m })),
    }),
    doc: vi.fn().mockReturnValue({ id: NEW_COMPANY_ID, path: `${path}/${NEW_COMPANY_ID}` }),
  } as never))

  vi.mocked(adminDb.doc).mockImplementation((path: string) => ({
    path,
    id: path.split('/').pop(),
    get: vi.fn().mockResolvedValue({ exists: path === `users/${UID}` ? userExists : false }),
  } as never))

  vi.mocked(adminDb.batch).mockReturnValue(batch as never)

  return { batch }
}

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
    vi.mocked(getCompanyDoc).mockResolvedValue({ exists: false } as never)

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
    const { batch } = wire({ memberships: [{ companyId: 'live-co' }] })
    vi.mocked(getCompanyDoc).mockResolvedValue({ exists: true } as never)

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
      (companyId: string) => Promise.resolve({ exists: companyId === 'live-co' }) as never,
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
