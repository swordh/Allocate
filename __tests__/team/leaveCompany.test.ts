/**
 * leaveCompany — self-service leave (issue #352), same transactional
 * sole-admin guard as removeMember/updateMemberRole plus a sole-member
 * guard neither of those needs. Pattern mirrors
 * __tests__/team/removeMember.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { wireDb, queryFor, makeTransaction, type DocMap } from '../helpers/firestore'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: { runTransaction: vi.fn() },
  adminAuth: {
    setCustomUserClaims: vi.fn(),
    revokeRefreshTokens: vi.fn(),
    createCustomToken: vi.fn(),
  },
}))

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/queries/members', () => ({
  listMembers: vi.fn(),
}))

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { leaveCompany } from '@/actions/team'
import { adminDb, adminAuth } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { listMembers } from '@/lib/queries/members'

const COMPANY_ID = 'company-A'
const COMPANY_ID_PATH = `companies/${COMPANY_ID}`
const META_PATH = `companies/${COMPANY_ID}/_meta/memberCounts`
const UID = 'leaver-1'
const SELF_PATH = `companies/${COMPANY_ID}/members/${UID}`

function wireTransaction(docs: DocMap) {
  const tx = makeTransaction(docs)
  vi.mocked(adminDb.runTransaction).mockImplementation(
    (cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx),
  )
  return tx
}

beforeEach(() => {
  vi.clearAllMocks()

  vi.mocked(getVerifiedSession).mockResolvedValue({
    uid: UID,
    email: 'leaver@example.com',
    activeCompanyId: COMPANY_ID,
    role: 'crew',
  } as never)

  vi.mocked(adminAuth.setCustomUserClaims).mockResolvedValue(undefined as never)
  vi.mocked(adminAuth.revokeRefreshTokens).mockResolvedValue(undefined as never)
  vi.mocked(adminAuth.createCustomToken).mockResolvedValue('custom-token-for-leaver' as never)
})

describe('leaveCompany', () => {
  it('lets a regular member leave their active company: deletes both membership docs, decrements counts, revokes tokens, returns a custom token', async () => {
    const docs: DocMap = {
      [SELF_PATH]: { role: 'crew' },
      [META_PATH]: { members: 5, admins: 2 },
      [COMPANY_ID_PATH]: { name: 'Acme' },
      // No remaining memberships — exercises the redirectCompanyId: null path.
    }
    wireDb(adminDb as unknown as Record<string, unknown>, {
      docs,
      query: queryFor(() => true, []),
    })
    const tx = wireTransaction(docs)

    const result = await leaveCompany(COMPANY_ID)

    expect(result.error).toBeUndefined()
    expect(result.blocked).toBeUndefined()
    expect(result.onlyMember).toBeUndefined()
    expect(result.left).toEqual({
      sessionRefresh: { redirectCompanyId: null, customToken: 'custom-token-for-leaver' },
    })

    expect(tx.delete).toHaveBeenCalledWith(expect.objectContaining({ path: SELF_PATH }))
    expect(tx.delete).toHaveBeenCalledWith(expect.objectContaining({ path: `users/${UID}/memberships/${COMPANY_ID}` }))

    const countsCall = tx.set.mock.calls.find((c) => (c[0] as { path: string }).path === META_PATH)
    expect(countsCall).toBeDefined()
    expect(countsCall![1]).toMatchObject({ members: expect.anything() })
    expect(countsCall![1]).not.toHaveProperty('admins')

    expect(adminAuth.setCustomUserClaims).toHaveBeenCalledWith(UID, { activeCompanyId: null, role: null })
    expect(adminAuth.revokeRefreshTokens).toHaveBeenCalledOnce()
    expect(adminAuth.revokeRefreshTokens).toHaveBeenCalledWith(UID)
    expect(adminAuth.createCustomToken).toHaveBeenCalledWith(UID)
  })

  // Issue #398: the session repoint used to trust `next.role as string` from
  // the remaining membership doc verbatim. The removed 'viewer' role (or any
  // other invalid value) there must now come out as 'crew' in the Custom
  // Claims write, with a warning logged.
  it('coerces the removed legacy viewer role on the remaining membership to crew and warns when repointing the session', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const REMAINING_COMPANY_ID = 'company-remaining'
    const docs: DocMap = {
      [SELF_PATH]: { role: 'crew' },
      [META_PATH]: { members: 5, admins: 2 },
      [COMPANY_ID_PATH]: { name: 'Acme' },
    }
    const query = queryFor(
      (ctx) => ctx.path === `users/${UID}/memberships`,
      [{ id: REMAINING_COMPANY_ID, path: `users/${UID}/memberships/${REMAINING_COMPANY_ID}`, data: { companyId: REMAINING_COMPANY_ID, role: 'viewer' } }],
      () => [],
    )
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })
    wireTransaction(docs)

    await leaveCompany(COMPANY_ID)

    expect(adminAuth.setCustomUserClaims).toHaveBeenCalledWith(UID, {
      activeCompanyId: REMAINING_COMPANY_ID,
      role: 'crew',
    })
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('coerces an invalid role on the remaining membership to crew when repointing the session', async () => {
    const REMAINING_COMPANY_ID = 'company-remaining'
    const docs: DocMap = {
      [SELF_PATH]: { role: 'crew' },
      [META_PATH]: { members: 5, admins: 2 },
      [COMPANY_ID_PATH]: { name: 'Acme' },
    }
    const query = queryFor(
      (ctx) => ctx.path === `users/${UID}/memberships`,
      [{ id: REMAINING_COMPANY_ID, path: `users/${UID}/memberships/${REMAINING_COMPANY_ID}`, data: { companyId: REMAINING_COMPANY_ID, role: 'owner' } }],
      () => [],
    )
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })
    wireTransaction(docs)

    await leaveCompany(COMPANY_ID)

    expect(adminAuth.setCustomUserClaims).toHaveBeenCalledWith(UID, {
      activeCompanyId: REMAINING_COMPANY_ID,
      role: 'crew',
    })
  })

  it('leaving a NON-active company writes the same membership deletes but skips claims/revoke/custom-token entirely', async () => {
    const OTHER_COMPANY_ID = 'company-B'
    const OTHER_PATH = `companies/${OTHER_COMPANY_ID}/members/${UID}`
    const OTHER_META_PATH = `companies/${OTHER_COMPANY_ID}/_meta/memberCounts`

    vi.mocked(getVerifiedSession).mockResolvedValue({
      uid: UID,
      email: 'leaver@example.com',
      // Caller's active company is COMPANY_ID, but they're leaving a DIFFERENT one.
      activeCompanyId: COMPANY_ID,
      role: 'crew',
    } as never)

    const docs: DocMap = {
      [OTHER_PATH]: { role: 'crew' },
      [OTHER_META_PATH]: { members: 5, admins: 2 },
      [`companies/${OTHER_COMPANY_ID}`]: { name: 'Other Co' },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query: queryFor(() => true, []) })
    const tx = wireTransaction(docs)

    const result = await leaveCompany(OTHER_COMPANY_ID)

    expect(result.error).toBeUndefined()
    expect(result.left).toEqual({ sessionRefresh: null })

    expect(tx.delete).toHaveBeenCalledWith(expect.objectContaining({ path: OTHER_PATH }))
    expect(adminAuth.setCustomUserClaims).not.toHaveBeenCalled()
    expect(adminAuth.revokeRefreshTokens).not.toHaveBeenCalled()
    expect(adminAuth.createCustomToken).not.toHaveBeenCalled()
  })

  it('decrements admins too when the leaver was an admin', async () => {
    const docs: DocMap = {
      [SELF_PATH]: { role: 'admin' },
      [META_PATH]: { members: 5, admins: 2 },
      [COMPANY_ID_PATH]: { name: 'Acme' },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query: queryFor(() => true, []) })
    const tx = wireTransaction(docs)

    const result = await leaveCompany(COMPANY_ID)

    expect(result.error).toBeUndefined()
    const countsCall = tx.set.mock.calls.find((c) => (c[0] as { path: string }).path === META_PATH)
    expect(countsCall![1]).toMatchObject({ admins: expect.anything() })
  })

  it('redirects to the next remaining membership when one exists', async () => {
    const docs: DocMap = {
      [SELF_PATH]: { role: 'crew' },
      [META_PATH]: { members: 5, admins: 2 },
      [COMPANY_ID_PATH]: { name: 'Acme' },
    }
    const query = queryFor(
      (ctx) => ctx.path === `users/${UID}/memberships`,
      [{ id: 'company-B', data: { companyId: 'company-B', role: 'admin' } }],
    )
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })
    wireTransaction(docs)

    const result = await leaveCompany(COMPANY_ID)

    expect(result.left).toEqual({
      sessionRefresh: { redirectCompanyId: 'company-B', customToken: 'custom-token-for-leaver' },
    })
    expect(adminAuth.setCustomUserClaims).toHaveBeenCalledWith(UID, {
      activeCompanyId: 'company-B',
      role: 'admin',
    })
  })

  it('blocks leaving when the caller is the sole admin and other members remain, and returns who can be promoted', async () => {
    const docs: DocMap = {
      [SELF_PATH]: { role: 'admin' },
      [META_PATH]: { members: 3, admins: 1 },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query: queryFor(() => true, []) })
    const tx = wireTransaction(docs)

    vi.mocked(listMembers).mockResolvedValue([
      { uid: UID, name: 'Leaver', email: 'leaver@example.com', role: 'admin', joinedAt: '' },
      { uid: 'crew-1', name: 'Crew One', email: 'crew1@example.com', role: 'crew', joinedAt: '' },
      { uid: 'crew-2', name: 'Crew Two', email: 'crew2@example.com', role: 'crew', joinedAt: '' },
    ] as never)

    const result = await leaveCompany(COMPANY_ID)

    expect(result.error).toBeUndefined()
    expect(result.left).toBeUndefined()
    expect(result.onlyMember).toBeUndefined()
    // `role` rides along so the successor picker can show it without a
    // second read — same shape getLeaveContext (actions/companies.ts) returns.
    expect(result.blocked).toEqual({
      promotable: [
        { uid: 'crew-1', name: 'Crew One', email: 'crew1@example.com', role: 'crew' },
        { uid: 'crew-2', name: 'Crew Two', email: 'crew2@example.com', role: 'crew' },
      ],
    })

    // Blocked before any write — proves the block came from the counter
    // read, not some unrelated failure.
    expect(tx.delete).not.toHaveBeenCalled()
    expect(tx.set).not.toHaveBeenCalled()
    expect(adminAuth.revokeRefreshTokens).not.toHaveBeenCalled()
  })

  it('routes to the existing deletion flow when the caller is the only member — no write of its own', async () => {
    const docs: DocMap = {
      [SELF_PATH]: { role: 'admin' },
      [META_PATH]: { members: 1, admins: 1 },
      [COMPANY_ID_PATH]: { name: 'Solo Co' },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query: queryFor(() => true, []) })
    const tx = wireTransaction(docs)

    const result = await leaveCompany(COMPANY_ID)

    expect(result.error).toBeUndefined()
    expect(result.left).toBeUndefined()
    expect(result.blocked).toBeUndefined()
    expect(result.onlyMember).toEqual({ companyName: 'Solo Co' })

    expect(tx.delete).not.toHaveBeenCalled()
    expect(tx.set).not.toHaveBeenCalled()
    expect(adminAuth.revokeRefreshTokens).not.toHaveBeenCalled()
    expect(adminAuth.createCustomToken).not.toHaveBeenCalled()
  })

  it('returns "Membership not found" when the caller has no member doc in that company', async () => {
    const docs: DocMap = {
      [META_PATH]: { members: 5, admins: 2 },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query: queryFor(() => true, []) })
    wireTransaction(docs)

    const result = await leaveCompany(COMPANY_ID)

    expect(result.error).toBe('Membership not found')
  })

  it('returns the indeterminate-guard message and makes no writes when the transaction throws something other than the typed sentinel', async () => {
    wireDb(adminDb as unknown as Record<string, unknown>, { docs: {}, query: queryFor(() => true, []) })
    vi.mocked(adminDb.runTransaction).mockRejectedValue(new Error('Firestore unavailable'))

    const result = await leaveCompany(COMPANY_ID)

    expect(result.error).toBe("Could not verify this company's administrators right now. No changes were made.")
  })

  it('FIX VERIFIED: only the first of two concurrent leaves of the last two admins succeeds', async () => {
    let callCount = 0
    const UID_A = 'admin-a'
    const UID_B = 'admin-b'
    const PATH_A = `companies/${COMPANY_ID}/members/${UID_A}`
    const PATH_B = `companies/${COMPANY_ID}/members/${UID_B}`

    vi.mocked(adminDb.runTransaction).mockImplementation(async (cb: unknown) => {
      callCount += 1
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
    vi.mocked(listMembers).mockResolvedValue([
      { uid: UID_A, name: 'A', email: 'a@example.com', role: 'admin', joinedAt: '' },
      { uid: UID_B, name: 'B', email: 'b@example.com', role: 'admin', joinedAt: '' },
    ] as never)

    vi.mocked(getVerifiedSession)
      .mockResolvedValueOnce({ uid: UID_A, email: 'a@example.com', activeCompanyId: COMPANY_ID, role: 'admin' } as never)
      .mockResolvedValueOnce({ uid: UID_B, email: 'b@example.com', activeCompanyId: COMPANY_ID, role: 'admin' } as never)

    const [result1, result2] = await Promise.all([leaveCompany(COMPANY_ID), leaveCompany(COMPANY_ID)])

    const successes = [result1, result2].filter((r) => r.left !== undefined)
    const blocked = [result1, result2].filter((r) => r.blocked !== undefined)

    expect(successes).toHaveLength(1)
    expect(blocked).toHaveLength(1)
  })
})
