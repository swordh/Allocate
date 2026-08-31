/**
 * inviteUser — seat guard (commit 5, redesign phase 2).
 *
 * Members + pending invitations count against subscription.limits.users.
 * An expired-but-still-`pending` invitation must not permanently consume a
 * seat — it's excluded via a `.count()` aggregate on `expiresAt < now`
 * rather than fetched and filtered in memory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {
    doc: vi.fn(),
    collection: vi.fn(),
    batch: vi.fn(),
  },
  adminAuth: {},
}))

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { inviteUser } from '@/actions/team'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { wireDb, filterValue, type DocMap, type QueryResolver } from '../helpers/firestore'

const COMPANY_ID = 'company-A'
const EMAIL = 'newcrew@example.com'

function stubSession() {
  vi.mocked(getVerifiedSession).mockResolvedValue({
    uid: 'admin-1',
    email: 'admin@example.com',
    activeCompanyId: COMPANY_ID,
    role: 'admin',
  })
}

/**
 * `memberCount` members, `pendingCount` pending invitations, of which
 * `expiredCount` are already expired.
 */
function wire({
  memberCount,
  pendingCount,
  expiredCount,
  limit,
}: {
  memberCount: number
  pendingCount: number
  expiredCount: number
  limit: number
}) {
  const docs: DocMap = {
    [`companies/${COMPANY_ID}/members/admin-1`]: { name: 'Admin One' },
    [`companies/${COMPANY_ID}`]: {
      name: 'Nordfilm AB',
      subscription: { limits: { users: limit } },
    },
  }

  const query: QueryResolver = (ctx) => {
    if (ctx.path === `companies/${COMPANY_ID}/members`) {
      // Distinguish the "already a member?" lookup (has an email filter,
      // always empty here) from the seat-guard member count (no filter).
      if (ctx.filters.some((f) => f.field === 'email')) return []
      return Array.from({ length: memberCount }, (_, i) => ({ id: `m${i}`, data: {} }))
    }
    if (ctx.path === `companies/${COMPANY_ID}/invitations`) {
      const expiresAtFilter = filterValue(ctx, 'expiresAt')
      if (expiresAtFilter !== undefined) {
        // status == pending AND expiresAt < now — the expired-pending count
        return Array.from({ length: expiredCount }, (_, i) => ({ id: `exp${i}`, data: {} }))
      }
      if (ctx.filters.some((f) => f.field === 'status')) {
        // Either the "already pending for this email" lookup (limit(1), no
        // results expected here) or the total-pending count.
        if (ctx.filters.some((f) => f.field === 'email')) return []
        return Array.from({ length: pendingCount }, (_, i) => ({ id: `p${i}`, data: {} }))
      }
    }
    return []
  }

  const wired = wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })

  const innerCollection = wired.collection as unknown as (path: string) => Record<string, unknown>
  const collectionWithAdd = vi.fn((path: string) => {
    const chain = innerCollection(path)
    chain['add'] = vi.fn().mockResolvedValue({ id: 'mail-1' })
    return chain
  })
  ;(adminDb as unknown as Record<string, unknown>)['collection'] = collectionWithAdd

  return wired
}

function makeFormData(email: string): FormData {
  const fd = new FormData()
  fd.set('email', email)
  return fd
}

describe('inviteUser — seat guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T00:00:00.000Z'))
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.allocate.at'
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('blocks a new invite when members + active pending invitations reach the limit', async () => {
    stubSession()
    wire({ memberCount: 3, pendingCount: 2, expiredCount: 0, limit: 5 })

    const result = await inviteUser(makeFormData(EMAIL))

    expect(result.error).toMatch(/seat limit reached/i)
  })

  it('allows a new invite when expired pending invitations free up a seat', async () => {
    // 3 members + 2 pending, but 1 of the pending is expired — active seats
    // used = 3 + (2 - 1) = 4, under the limit of 5.
    stubSession()
    const { batch } = wire({ memberCount: 3, pendingCount: 2, expiredCount: 1, limit: 5 })

    const result = await inviteUser(makeFormData(EMAIL))

    expect(result.error).toBeUndefined()
    expect(batch.set).toHaveBeenCalled()
  })

  it('allows a new invite when comfortably under the limit', async () => {
    stubSession()
    const { batch } = wire({ memberCount: 1, pendingCount: 0, expiredCount: 0, limit: 5 })

    const result = await inviteUser(makeFormData(EMAIL))

    expect(result.error).toBeUndefined()
    expect(batch.set).toHaveBeenCalled()
  })
})
