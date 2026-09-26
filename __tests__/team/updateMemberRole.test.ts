/**
 * updateMemberRole — transactional sole-admin guard (issue #252 PR-2).
 *
 * This function had ZERO test coverage before this file — plausibly why it
 * shipped with no sole-admin guard at all: the self-demote block on `:335`
 * only stops an admin demoting THEMSELVES, so two admins could demote each
 * other simultaneously and leave a company with no admin. It now reads
 * `_meta/memberCounts` (lib/companyStats.ts) inside a `runTransaction` and
 * refuses a demotion that would leave `admins <= 1`, the same guard shape as
 * `removeMember`.
 *
 * `lib/companyStats.ts` is NOT mocked — memberCountsDelta's own
 * FieldValue.increment/serverTimestamp calls run for real (see
 * removeMember.test.ts's identical note).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { wireDb, filterValue, makeTransaction, type DocMap, type QueryResolver } from '../helpers/firestore'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: { runTransaction: vi.fn() },
  adminAuth: {
    getUser: vi.fn(),
    setCustomUserClaims: vi.fn(),
    revokeRefreshTokens: vi.fn(),
  },
}))

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { updateMemberRole } from '@/actions/team'
import { adminDb, adminAuth } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'

const COMPANY_ID = 'company-A'
const META_PATH = `companies/${COMPANY_ID}/_meta/memberCounts`
const ADMIN_UID = 'admin-1'
const TARGET_UID = 'target-1'
const TARGET_MEMBER_PATH = `companies/${COMPANY_ID}/members/${TARGET_UID}`
const TARGET_MEMBERSHIP_PATH = `users/${TARGET_UID}/memberships/${COMPANY_ID}`

function wireTransaction(docs: DocMap) {
  const tx = makeTransaction(docs)
  vi.mocked(adminDb.runTransaction).mockImplementation(
    (cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx),
  )
  return tx
}

describe('updateMemberRole — transactional sole-admin guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(getVerifiedSession).mockResolvedValue({
      uid: ADMIN_UID,
      email: 'admin@example.com',
      activeCompanyId: COMPANY_ID,
      role: 'admin',
    } as never)

    // Claims default: no matching activeCompanyId, so most tests don't
    // exercise setCustomUserClaims unless they wire it explicitly.
    vi.mocked(adminAuth.getUser).mockResolvedValue({
      customClaims: {},
    } as never)
    vi.mocked(adminAuth.setCustomUserClaims).mockResolvedValue(undefined as never)
    vi.mocked(adminAuth.revokeRefreshTokens).mockResolvedValue(undefined as never)
  })

  it('promotes crew to admin: writes both role docs and increments admins', async () => {
    const docs: DocMap = {
      [TARGET_MEMBER_PATH]: { role: 'crew' },
      [META_PATH]: { members: 3, admins: 1 },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs })
    const tx = wireTransaction(docs)

    const result = await updateMemberRole(TARGET_UID, 'admin')

    expect(result.error).toBeUndefined()
    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: TARGET_MEMBER_PATH }),
      { role: 'admin' },
    )
    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: TARGET_MEMBERSHIP_PATH }),
      { role: 'admin' },
    )
    const countsCall = tx.set.mock.calls.find((c) => (c[0] as { path: string }).path === META_PATH)
    expect(countsCall).toBeDefined()
    expect(countsCall![1]).toMatchObject({ admins: expect.anything() })
    expect(countsCall![1]).not.toHaveProperty('members')
  })

  it('demotes admin to crew when another admin exists', async () => {
    const docs: DocMap = {
      [TARGET_MEMBER_PATH]: { role: 'admin' },
      [META_PATH]: { members: 3, admins: 2 },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs })
    wireTransaction(docs)

    const result = await updateMemberRole(TARGET_UID, 'crew')

    expect(result.error).toBeUndefined()
  })

  it('refuses to demote the only admin — real read, not a vacuous pass', async () => {
    const docs: DocMap = {
      [TARGET_MEMBER_PATH]: { role: 'admin' },
      [META_PATH]: { members: 1, admins: 1 },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs })
    const tx = wireTransaction(docs)

    const result = await updateMemberRole(TARGET_UID, 'crew')

    expect(result.error).toBe('Cannot demote the only admin. Promote another member first.')
    expect(tx.update).not.toHaveBeenCalled()
    expect(tx.set).not.toHaveBeenCalled()
    expect(adminAuth.setCustomUserClaims).not.toHaveBeenCalled()
  })

  it('allows demoting one of several admins (admins > 1)', async () => {
    const docs: DocMap = {
      [TARGET_MEMBER_PATH]: { role: 'admin' },
      [META_PATH]: { members: 4, admins: 3 },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs })
    const tx = wireTransaction(docs)

    const result = await updateMemberRole(TARGET_UID, 'crew')

    expect(result.error).toBeUndefined()
    const countsCall = tx.set.mock.calls.find((c) => (c[0] as { path: string }).path === META_PATH)
    expect(countsCall![1]).toMatchObject({ admins: expect.anything() })
  })

  it('is a no-op when the role is unchanged: no writes, no claims sync', async () => {
    const docs: DocMap = {
      [TARGET_MEMBER_PATH]: { role: 'crew' },
      [META_PATH]: { members: 3, admins: 1 },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs })
    const tx = wireTransaction(docs)

    const result = await updateMemberRole(TARGET_UID, 'crew')

    expect(result.error).toBeUndefined()
    expect(tx.update).not.toHaveBeenCalled()
    expect(tx.set).not.toHaveBeenCalled()
    expect(adminAuth.getUser).not.toHaveBeenCalled()
    expect(adminAuth.setCustomUserClaims).not.toHaveBeenCalled()
    // No role actually changed, so there is nothing for a stale session to
    // keep acting on — revocation would be pure noise here.
    expect(adminAuth.revokeRefreshTokens).not.toHaveBeenCalled()
  })

  it('returns "Member not found" when the target member doc does not exist', async () => {
    const docs: DocMap = {
      [META_PATH]: { members: 3, admins: 1 },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs })
    wireTransaction(docs)

    const result = await updateMemberRole(TARGET_UID, 'admin')

    expect(result.error).toBe('Member not found')
  })

  it('self-heals _meta/memberCounts from a live aggregate when the counter doc is missing', async () => {
    const docs: DocMap = {
      [TARGET_MEMBER_PATH]: { role: 'admin' },
      // No META_PATH — counter not seeded for this company.
    }
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

    // 2 admins currently — demoting one is safe.
    const result = await updateMemberRole(TARGET_UID, 'crew')

    expect(result.error).toBeUndefined()
    const countsCall = tx.set.mock.calls.find((c) => (c[0] as { path: string }).path === META_PATH)
    expect(countsCall).toBeDefined()
  })

  it('syncs claims only when the target user is currently active in this company', async () => {
    const docs: DocMap = {
      [TARGET_MEMBER_PATH]: { role: 'crew' },
      [META_PATH]: { members: 3, admins: 1 },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs })
    wireTransaction(docs)
    vi.mocked(adminAuth.getUser).mockResolvedValue({
      customClaims: { activeCompanyId: COMPANY_ID },
    } as never)

    const result = await updateMemberRole(TARGET_UID, 'admin')

    expect(result.error).toBeUndefined()
    expect(adminAuth.setCustomUserClaims).toHaveBeenCalledWith(TARGET_UID, {
      activeCompanyId: COMPANY_ID,
      role: 'admin',
    })
    expect(adminAuth.revokeRefreshTokens).toHaveBeenCalledWith(TARGET_UID)
    // Ordering matches switchCompany's own claims-then-revoke shape.
    expect(vi.mocked(adminAuth.setCustomUserClaims).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(adminAuth.revokeRefreshTokens).mock.invocationCallOrder[0]!,
    )
  })

  it('does not sync claims when the target is active in a DIFFERENT company, but still revokes their tokens', async () => {
    const docs: DocMap = {
      [TARGET_MEMBER_PATH]: { role: 'crew' },
      [META_PATH]: { members: 3, admins: 1 },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs })
    wireTransaction(docs)
    vi.mocked(adminAuth.getUser).mockResolvedValue({
      customClaims: { activeCompanyId: 'some-other-company' },
    } as never)

    const result = await updateMemberRole(TARGET_UID, 'admin')

    expect(result.error).toBeUndefined()
    expect(adminAuth.setCustomUserClaims).not.toHaveBeenCalled()
    // Unconditional: the role on companies/{cid}/members/{uid} changed
    // regardless of which company the target currently has active, and a
    // future switchCompany back into this company must not succeed on a
    // token minted before this change.
    expect(adminAuth.revokeRefreshTokens).toHaveBeenCalledWith(TARGET_UID)
  })

  it('returns {} even when the claims sync fails after a successful commit', async () => {
    const docs: DocMap = {
      [TARGET_MEMBER_PATH]: { role: 'crew' },
      [META_PATH]: { members: 3, admins: 1 },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs })
    wireTransaction(docs)
    vi.mocked(adminAuth.getUser).mockRejectedValue(new Error('Auth service unavailable'))

    const result = await updateMemberRole(TARGET_UID, 'admin')

    // Non-fatal: the role change already committed, so this must not
    // surface as an error to the caller.
    expect(result.error).toBeUndefined()
    // The claims block's own try/catch swallowed its failure — that must not
    // skip the separate, unconditional revoke call that follows it.
    expect(adminAuth.revokeRefreshTokens).toHaveBeenCalledWith(TARGET_UID)
  })

  it('revokes refresh tokens on a real role change', async () => {
    const docs: DocMap = {
      [TARGET_MEMBER_PATH]: { role: 'crew' },
      [META_PATH]: { members: 3, admins: 1 },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs })
    wireTransaction(docs)

    const result = await updateMemberRole(TARGET_UID, 'admin')

    expect(result.error).toBeUndefined()
    expect(adminAuth.revokeRefreshTokens).toHaveBeenCalledWith(TARGET_UID)
  })

  it('returns {} even when revokeRefreshTokens itself fails after a successful commit', async () => {
    const docs: DocMap = {
      [TARGET_MEMBER_PATH]: { role: 'crew' },
      [META_PATH]: { members: 3, admins: 1 },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs })
    wireTransaction(docs)
    vi.mocked(adminAuth.revokeRefreshTokens).mockRejectedValue(new Error('Auth service unavailable'))

    const result = await updateMemberRole(TARGET_UID, 'admin')

    // Non-fatal: the role change already committed and is the source of
    // truth going forward — a stale session surviving a little longer than
    // intended is not a reason to report this operation as failed.
    expect(result.error).toBeUndefined()
  })

  it('rejects a self-role-change before touching the transaction', async () => {
    wireDb(adminDb as unknown as Record<string, unknown>, { docs: {} })

    const result = await updateMemberRole(ADMIN_UID, 'crew')

    expect(result.error).toBe("You can't change your own role")
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
  })

  it('rejects an invalid role before touching the transaction', async () => {
    wireDb(adminDb as unknown as Record<string, unknown>, { docs: {} })

    const result = await updateMemberRole(TARGET_UID, 'owner' as never)

    expect(result.error).toBe('Invalid role')
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
  })

  it('rejects the removed legacy role viewer — admin input is never coerced to crew', async () => {
    // Unlike toRole's silent coercion of a stored/claimed 'viewer' to
    // 'crew', an admin explicitly SUBMITTING 'viewer' here is refused
    // outright (issue #397) — this is deliberate, unvalidated client input,
    // not a legacy document being read.
    wireDb(adminDb as unknown as Record<string, unknown>, { docs: {} })

    const result = await updateMemberRole(TARGET_UID, 'viewer' as never)

    expect(result.error).toBe('Invalid role')
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
  })

  it('rejects when the session has no active company, before touching the transaction', async () => {
    // Same string and guard shape as removeMember's identical check —
    // reachable via a company-switch race or a partially revoked claim
    // (session.role === 'admin' but activeCompanyId missing). Without this
    // guard, companyId would be undefined and the code would silently build
    // a `companies/undefined/members/...` path instead of refusing cleanly.
    vi.mocked(getVerifiedSession).mockResolvedValue({
      uid: ADMIN_UID,
      email: 'admin@example.com',
      activeCompanyId: undefined,
      role: 'admin',
    } as never)
    wireDb(adminDb as unknown as Record<string, unknown>, { docs: {} })

    const result = await updateMemberRole(TARGET_UID, 'admin')

    expect(result.error).toBe('No active company')
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
  })

  it('returns the indeterminate-guard message and makes no writes when the transaction throws something other than the typed sentinel', async () => {
    // Issue #252 point 3 is precisely about this branch: a bug here — wrong
    // string, or an error silently swallowed as a false success — would slip
    // through untested otherwise.
    const docs: DocMap = {
      [TARGET_MEMBER_PATH]: { role: 'crew' },
      [META_PATH]: { members: 3, admins: 1 },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs })
    vi.mocked(adminDb.runTransaction).mockRejectedValue(new Error('Firestore unavailable'))

    const result = await updateMemberRole(TARGET_UID, 'admin')

    expect(result.error).toBe("Could not verify this company's administrators right now. No changes were made.")
    expect(adminAuth.setCustomUserClaims).not.toHaveBeenCalled()
  })

  // ── Confirm the TOCTOU bug (no guard at all, previously) is fixed ───────────
  //
  // Two admins demoting each other simultaneously — copied from the same
  // pattern __tests__/equipment/planLimit.test.ts:460-523 uses.
  it('FIX VERIFIED: only the first of two concurrent mutual demotions succeeds', async () => {
    let callCount = 0
    const ADMIN_A = 'admin-a'
    const ADMIN_B = 'admin-b'
    const PATH_A = `companies/${COMPANY_ID}/members/${ADMIN_A}`
    const PATH_B = `companies/${COMPANY_ID}/members/${ADMIN_B}`

    vi.mocked(adminDb.runTransaction).mockImplementation(async (cb: unknown) => {
      callCount += 1
      const admins = callCount === 1 ? 2 : 1
      const docs: DocMap = {
        [PATH_A]: { role: 'admin' },
        [PATH_B]: { role: 'admin' },
        [META_PATH]: { members: 5, admins },
      }
      const tx = makeTransaction(docs)
      return (cb as (tx: unknown) => Promise<unknown>)(tx)
    })
    wireDb(adminDb as unknown as Record<string, unknown>, { docs: {} })

    const [result1, result2] = await Promise.all([
      updateMemberRole(ADMIN_A, 'crew'),
      updateMemberRole(ADMIN_B, 'crew'),
    ])

    const successes = [result1, result2].filter((r) => r.error === undefined)
    const failures = [result1, result2].filter((r) => r.error !== undefined)

    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.error).toBe('Cannot demote the only admin. Promote another member first.')
  })
})
