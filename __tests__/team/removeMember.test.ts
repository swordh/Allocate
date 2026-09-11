/**
 * removeMember — memberCount decrement (redesign/fas-5-member-count).
 *
 * companies/{id}.stats.memberCount must be decremented in the SAME WriteBatch
 * chunk as the companies/{cid}/members/{memberId} delete. removeMember chunks
 * its batch at BATCH_LIMIT via addOp/commitAndReset; the decrement is emitted
 * as a bare batch.set (merge) immediately after the member delete (not
 * through addOp) specifically so nothing can land between them and push the
 * delete into one chunk and the decrement into another.
 *
 * memberCountDelta uses `.set(..., { merge: true })`, not `.update()` —
 * `.update()` throws when the target document is missing, which would turn a
 * stats mirror write into a reason the whole member-removal batch fails.
 *
 * `lib/companyStats.ts` is NOT mocked here — memberCountDelta's own
 * FieldValue.increment/serverTimestamp calls run for real, the same way
 * `__tests__/auth/setupNewCompany.test.ts` already exercises FieldValue calls
 * without mocking `firebase-admin/firestore`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { wireDb, queryFor } from '../helpers/firestore'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {},
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
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'

const COMPANY_ID = 'company-A'
const COMPANY_ID_PATH = `companies/${COMPANY_ID}`
const ADMIN_UID = 'admin-1'
const TARGET_UID = 'target-1'

describe('removeMember — memberCount decrement', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(getVerifiedSession).mockResolvedValue({
      uid: ADMIN_UID,
      email: 'admin@example.com',
      activeCompanyId: COMPANY_ID,
      role: 'admin',
    } as never)
  })

  it('decrements stats.memberCount in the same batch/commit as the member delete', async () => {
    const wired = wireDb(adminDb as unknown as Record<string, unknown>, {
      docs: {
        // Target is a plain crew member — skips the sole-admin admin-count query.
        [`companies/${COMPANY_ID}/members/${TARGET_UID}`]: { role: 'crew' },
        // createdBy does not match the target, so the later addOp(companyRef,
        // { createdBy: null }) branch never fires — keeps this test focused on
        // the member-delete + memberCount write only.
        [`companies/${COMPANY_ID}`]: { name: 'Acme', createdBy: 'someone-else' },
        // Not the removed member's own active company — skips the claims-sync
        // branch in step 5, which is unrelated to memberCount.
        [`users/${TARGET_UID}`]: { activeCompanyId: 'company-B' },
      },
      // Every where()-filtered query (bookings/equipment anonymisation scans,
      // and the full equipment collection walk) returns nothing to anonymise.
      query: queryFor(() => true, []),
    })

    const result = await removeMember(TARGET_UID)

    expect(result.error).toBeUndefined()

    const memberDeletePath = `companies/${COMPANY_ID}/members/${TARGET_UID}`
    const deleteCalls = wired.batch.delete.mock.calls.map((c) => (c[0] as { path: string }).path)
    expect(deleteCalls).toContain(memberDeletePath)

    const setCalls = wired.batch.set.mock.calls
    const statsSet = setCalls.find((c) => (c[0] as { path: string }).path === COMPANY_ID_PATH)
    expect(statsSet).toBeDefined()
    const [, data, options] = statsSet!
    expect(data).toMatchObject({
      stats: {
        memberCount: expect.anything(),
        updatedAt: expect.anything(),
      },
    })
    // Merge-set, never a bare .update() — memberCount is a mirror only (no
    // _meta counter backs it), so it must never fail the whole batch just
    // because companies/{id} happened to be missing.
    expect(options).toMatchObject({ merge: true })

    // Same batch, one commit — proves no chunk rotation could have split the
    // delete and the decrement across two separate WriteBatch commits.
    expect(adminDb.batch).toHaveBeenCalledTimes(1)
    expect(wired.batch.commit).toHaveBeenCalledTimes(1)

    // The decrement is emitted immediately after the member delete, before
    // any of the (potentially large) anonymisation ops below it.
    const deleteIndex = wired.batch.delete.mock.calls.findIndex(
      (c) => (c[0] as { path: string }).path === memberDeletePath,
    )
    const setIndex = wired.batch.set.mock.invocationCallOrder[setCalls.indexOf(statsSet!)]
    const deleteCallOrder = wired.batch.delete.mock.invocationCallOrder[deleteIndex]
    expect(deleteCallOrder).toBeLessThan(setIndex)
  })
})
