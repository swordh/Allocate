/**
 * removeMember — transactional sole-admin guard + memberCounts decrement
 * (issue #252 PR-2).
 *
 * The old guard ran a `.count()` query OUTSIDE any transaction, then applied
 * the member deletes and the memberCount decrement in a separate WriteBatch —
 * a classic TOCTOU: two concurrent removals of two different admins could
 * each read count=2, both pass, and both commit, leaving zero admins. The
 * guard, the two membership deletes, and the `_meta/memberCounts` +
 * `stats.memberCount` delta now all live inside ONE `runTransaction` — see
 * `readMemberCounts`/`memberCountsDelta` in lib/companyStats.ts.
 *
 * `lib/companyStats.ts` is NOT mocked here — memberCountsDelta's own
 * FieldValue.increment/serverTimestamp calls run for real, the same way
 * `__tests__/auth/setupNewCompany.test.ts` already exercises FieldValue calls
 * without mocking `firebase-admin/firestore`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { wireDb, queryFor, filterValue, makeTransaction, type DocMap, type QueryResolver } from '../helpers/firestore'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: { runTransaction: vi.fn() },
  adminAuth: {
    getUser: vi.fn(),
    setCustomUserClaims: vi.fn(),
  },
}))

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { removeMember } from '@/actions/team'
import { adminDb, adminAuth } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'

const COMPANY_ID = 'company-A'
const COMPANY_ID_PATH = `companies/${COMPANY_ID}`
const META_PATH = `companies/${COMPANY_ID}/_meta/memberCounts`
const ADMIN_UID = 'admin-1'
const TARGET_UID = 'target-1'
const TARGET_PATH = `companies/${COMPANY_ID}/members/${TARGET_UID}`

/** Wire adminDb.runTransaction to invoke `cb` with a transaction stub backed by `docs`. */
function wireTransaction(docs: DocMap) {
  const tx = makeTransaction(docs)
  vi.mocked(adminDb.runTransaction).mockImplementation(
    (cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx),
  )
  return tx
}

describe('removeMember — transactional sole-admin guard + memberCounts decrement', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(getVerifiedSession).mockResolvedValue({
      uid: ADMIN_UID,
      email: 'admin@example.com',
      activeCompanyId: COMPANY_ID,
      role: 'admin',
    } as never)
  })

  it('decrements _meta/memberCounts and stats.memberCount in the same transaction as the member delete', async () => {
    const docs: DocMap = {
      [TARGET_PATH]: { role: 'crew' },
      [META_PATH]: { members: 5, admins: 2 },
      // createdBy does not match the target, so the later addOp(companyRef,
      // { createdBy: null }) branch never fires — keeps this test focused on
      // the transaction's writes only.
      [COMPANY_ID_PATH]: { name: 'Acme', createdBy: 'someone-else' },
      // Not the removed member's own active company — skips the claims-sync
      // branch in step 5, which is unrelated to memberCount.
      [`users/${TARGET_UID}`]: { activeCompanyId: 'company-B' },
    }

    const wired = wireDb(adminDb as unknown as Record<string, unknown>, {
      docs,
      // Every where()-filtered query (bookings/equipment anonymisation scans,
      // and the full equipment collection walk) returns nothing to anonymise.
      query: queryFor(() => true, []),
    })
    const tx = wireTransaction(docs)

    const result = await removeMember(TARGET_UID)

    expect(result.error).toBeUndefined()

    expect(tx.delete).toHaveBeenCalledWith(expect.objectContaining({ path: TARGET_PATH }))
    expect(tx.delete).toHaveBeenCalledWith(
      expect.objectContaining({ path: `users/${TARGET_UID}/memberships/${COMPANY_ID}` }),
    )

    // The counter write: crew target, so admins delta is 0 and must be
    // omitted entirely (memberCountsDelta's contract) — only `members` and
    // `updatedAt` should appear.
    const countsCall = tx.set.mock.calls.find(
      (c) => (c[0] as { path: string }).path === META_PATH,
    )
    expect(countsCall).toBeDefined()
    const [, countsData, countsOptions] = countsCall!
    expect(countsData).toMatchObject({ members: expect.anything(), updatedAt: expect.anything() })
    expect(countsData).not.toHaveProperty('admins')
    expect(countsOptions).toMatchObject({ merge: true })

    // The stats.memberCount mirror on the company doc, merge-set, never
    // .update() — a missing company doc must never fail the whole removal
    // over a denormalized counter.
    const statsCall = tx.set.mock.calls.find(
      (c) => (c[0] as { path: string }).path === COMPANY_ID_PATH,
    )
    expect(statsCall).toBeDefined()
    const [, statsData, statsOptions] = statsCall!
    expect(statsData).toMatchObject({
      stats: { memberCount: expect.anything(), updatedAt: expect.anything() },
    })
    expect(statsOptions).toMatchObject({ merge: true })

    // One transaction, nothing else — the WriteBatch used for anonymisation
    // is a SEPARATE commit and is exercised elsewhere; this test only cares
    // that the guard + deletes + delta happened together.
    expect(adminDb.runTransaction).toHaveBeenCalledTimes(1)
    expect(wired.batch.commit).toHaveBeenCalledTimes(1)
  })

  it('decrements admins too when the removed member was an admin', async () => {
    const docs: DocMap = {
      [TARGET_PATH]: { role: 'admin' },
      [META_PATH]: { members: 5, admins: 2 },
      [COMPANY_ID_PATH]: { name: 'Acme' },
      [`users/${TARGET_UID}`]: { activeCompanyId: 'company-B' },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query: queryFor(() => true, []) })
    const tx = wireTransaction(docs)

    const result = await removeMember(TARGET_UID)

    expect(result.error).toBeUndefined()
    const countsCall = tx.set.mock.calls.find((c) => (c[0] as { path: string }).path === META_PATH)
    expect(countsCall![1]).toMatchObject({ admins: expect.anything() })
  })

  // Issue #398: the removed member's activeCompanyId repoint used to trust
  // `next.role as string` from the remaining membership doc verbatim. A
  // legacy 'viewer' role (or any other invalid value) there must now come
  // out as 'crew' in the Custom Claims write, never pass through raw.
  it('coerces a legacy viewer role on the target\'s remaining membership to crew when repointing claims', async () => {
    const OTHER_COMPANY_ID = 'company-remaining'
    const docs: DocMap = {
      [TARGET_PATH]: { role: 'crew' },
      [META_PATH]: { members: 5, admins: 2 },
      [COMPANY_ID_PATH]: { name: 'Acme', createdBy: 'someone-else' },
      // The removed member's OWN active company IS the one she's being
      // removed from — this is what triggers the repoint branch.
      [`users/${TARGET_UID}`]: { activeCompanyId: COMPANY_ID },
    }

    const query: QueryResolver = queryFor(
      (ctx) => ctx.path === `users/${TARGET_UID}/memberships`,
      [{ id: OTHER_COMPANY_ID, path: `users/${TARGET_UID}/memberships/${OTHER_COMPANY_ID}`, data: { companyId: OTHER_COMPANY_ID, role: 'viewer' } }],
      () => [],
    )
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })
    wireTransaction(docs)

    const result = await removeMember(TARGET_UID)

    expect(result.error).toBeUndefined()
    expect(adminAuth.setCustomUserClaims).toHaveBeenCalledWith(TARGET_UID, {
      activeCompanyId: OTHER_COMPANY_ID,
      role: 'crew',
    })
  })

  it('coerces an invalid role on the remaining membership to crew when repointing claims', async () => {
    const OTHER_COMPANY_ID = 'company-remaining'
    const docs: DocMap = {
      [TARGET_PATH]: { role: 'crew' },
      [META_PATH]: { members: 5, admins: 2 },
      [COMPANY_ID_PATH]: { name: 'Acme', createdBy: 'someone-else' },
      [`users/${TARGET_UID}`]: { activeCompanyId: COMPANY_ID },
    }

    const query: QueryResolver = queryFor(
      (ctx) => ctx.path === `users/${TARGET_UID}/memberships`,
      [{ id: OTHER_COMPANY_ID, path: `users/${TARGET_UID}/memberships/${OTHER_COMPANY_ID}`, data: { companyId: OTHER_COMPANY_ID, role: 'owner' } }],
      () => [],
    )
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })
    wireTransaction(docs)

    await removeMember(TARGET_UID)

    expect(adminAuth.setCustomUserClaims).toHaveBeenCalledWith(TARGET_UID, {
      activeCompanyId: OTHER_COMPANY_ID,
      role: 'crew',
    })
  })

  it('blocks removal of the sole admin — real read, not a vacuous pass', async () => {
    const docs: DocMap = {
      [TARGET_PATH]: { role: 'admin' },
      [META_PATH]: { members: 1, admins: 1 },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query: queryFor(() => true, []) })
    const tx = wireTransaction(docs)

    const result = await removeMember(TARGET_UID)

    expect(result.error).toBe('Cannot remove the only admin. Promote another member first.')
    // The guard rejected before any write — proves the block came from the
    // counter read, not from some unrelated failure that happened to also
    // return an error string.
    expect(tx.delete).not.toHaveBeenCalled()
    expect(tx.set).not.toHaveBeenCalled()
  })

  it('returns "Member not found" when the target member doc does not exist', async () => {
    const docs: DocMap = {
      [META_PATH]: { members: 5, admins: 2 },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query: queryFor(() => true, []) })
    wireTransaction(docs)

    const result = await removeMember(TARGET_UID)

    expect(result.error).toBe('Member not found')
  })

  it('returns the indeterminate-guard message and makes no writes when the transaction throws something other than the typed sentinel', async () => {
    // Issue #252 point 3 is precisely about this branch: a bug here — wrong
    // string, or an error silently swallowed as a false success — would slip
    // through untested otherwise.
    wireDb(adminDb as unknown as Record<string, unknown>, { docs: {}, query: queryFor(() => true, []) })
    vi.mocked(adminDb.runTransaction).mockRejectedValue(new Error('Firestore unavailable'))

    const result = await removeMember(TARGET_UID)

    expect(result.error).toBe("Could not verify this company's administrators right now. No changes were made.")
  })

  it('self-heals _meta/memberCounts from a live aggregate when the counter doc is missing', async () => {
    const docs: DocMap = {
      [TARGET_PATH]: { role: 'crew' },
      [COMPANY_ID_PATH]: { name: 'Acme' },
      // No META_PATH entry — counter doc doesn't exist for this company.
    }
    // 3 members total, 2 admins — the live aggregate readMemberCounts falls
    // back to when the counter doc is missing. The resolver must actually
    // apply the `role` filter, since readMemberCounts issues both an
    // unfiltered members.count() and a filtered
    // members.where('role','==','admin').count() against the same
    // collection path.
    const membersDocs = [
      { id: 'a', data: { role: 'admin' } },
      { id: 'b', data: { role: 'admin' } },
      { id: 'c', data: { role: 'crew' } },
    ]
    const query: QueryResolver = (ctx) => {
      if (ctx.path !== `companies/${COMPANY_ID}/members`) return []
      const roleFilter = filterValue(ctx, 'role')
      return roleFilter ? membersDocs.filter((d) => d.data.role === roleFilter) : membersDocs
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })
    const tx = wireTransaction(docs)

    const result = await removeMember(TARGET_UID)

    expect(result.error).toBeUndefined()
    // applyHeal() must have written the healed absolute values back.
    const countsCall = tx.set.mock.calls.find((c) => (c[0] as { path: string }).path === META_PATH)
    expect(countsCall).toBeDefined()
  })

  // ── Confirm the TOCTOU bug is fixed ─────────────────────────────────────────
  //
  // Simulates two concurrent removeMember calls targeting the company's last
  // two admins. Firestore transactions serialise, so the second callback runs
  // against state the first one already committed — copied from the same
  // pattern __tests__/equipment/planLimit.test.ts:460-523 uses for the
  // equipment counter.
  it('FIX VERIFIED: only the first of two concurrent removals of the last two admins succeeds', async () => {
    let callCount = 0
    const TARGET_A = 'admin-a'
    const TARGET_B = 'admin-b'
    const PATH_A = `companies/${COMPANY_ID}/members/${TARGET_A}`
    const PATH_B = `companies/${COMPANY_ID}/members/${TARGET_B}`

    vi.mocked(adminDb.runTransaction).mockImplementation(async (cb: unknown) => {
      callCount += 1
      // First call sees 2 admins (safe); the second sees 1 (the first call's
      // decrement already committed) — simulates Firestore's serialisation.
      const admins = callCount === 1 ? 2 : 1
      const docs: DocMap = {
        [PATH_A]: { role: 'admin' },
        [PATH_B]: { role: 'admin' },
        [META_PATH]: { members: 5, admins },
        [COMPANY_ID_PATH]: { name: 'Acme' },
      }
      const tx = makeTransaction(docs)
      return (cb as (tx: unknown) => Promise<unknown>)(tx)
    })

    wireDb(adminDb as unknown as Record<string, unknown>, { docs: {}, query: queryFor(() => true, []) })

    const [result1, result2] = await Promise.all([
      removeMember(TARGET_A),
      removeMember(TARGET_B),
    ])

    const successes = [result1, result2].filter((r) => r.error === undefined)
    const failures = [result1, result2].filter((r) => r.error !== undefined)

    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.error).toBe('Cannot remove the only admin. Promote another member first.')
  })
})
