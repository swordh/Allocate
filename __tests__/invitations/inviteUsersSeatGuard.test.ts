/**
 * inviteUsers — seat guard.
 *
 * Members + pending invitations count against subscription.limits.users.
 * The old per-address `inviteUser` used three count() aggregates for this;
 * `inviteUsers` instead reads the full members and pending-invitations
 * collections once (bounded — max ~30 members) and derives both the exact
 * counts and the email sets needed for classification from the same reads.
 *
 * An expired-but-still-`pending` invitation must not permanently consume a
 * seat, so wired pending docs must be real documents with an `expiresAt`
 * field — `computeSeatsUsed` (lib/invite-recipients.ts) filters them out
 * in memory rather than via a `count()` aggregate.
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

import { inviteUsers } from '@/actions/team'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { wireDb, type DocMap, type QueryDocInput, type QueryResolver } from '../helpers/firestore'

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

  const activeCount = pendingCount - expiredCount
  const activePending: QueryDocInput[] = Array.from({ length: activeCount }, (_, i) => ({
    id: `active${i}`,
    data: { email: `active${i}@example.com`, status: 'pending', expiresAt: '2099-01-01T00:00:00.000Z' },
  }))
  const expiredPending: QueryDocInput[] = Array.from({ length: expiredCount }, (_, i) => ({
    id: `expired${i}`,
    data: { email: `expired${i}@example.com`, status: 'pending', expiresAt: '2020-01-01T00:00:00.000Z' },
  }))

  const query: QueryResolver = (ctx) => {
    if (ctx.path === `companies/${COMPANY_ID}/members`) {
      return Array.from({ length: memberCount }, (_, i) => ({
        id: `m${i}`,
        data: { email: `member${i}@example.com` },
      }))
    }
    if (ctx.path === `companies/${COMPANY_ID}/invitations`) {
      return [...activePending, ...expiredPending]
    }
    return []
  }

  return wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })
}

describe('inviteUsers — seat guard', () => {
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
    const { batch } = wire({ memberCount: 3, pendingCount: 2, expiredCount: 0, limit: 5 })

    const result = await inviteUsers([EMAIL], 'crew')

    expect(result.error).toMatch(/seat limit reached/i)
    expect(batch.set).not.toHaveBeenCalled()
  })

  it('allows a new invite when expired pending invitations free up a seat', async () => {
    // 3 members + 2 pending, 1 expired — active seats used = 3 + 1 = 4, under limit 5.
    stubSession()
    const { batch } = wire({ memberCount: 3, pendingCount: 2, expiredCount: 1, limit: 5 })

    const result = await inviteUsers([EMAIL], 'crew')

    expect(result.error).toBeUndefined()
    expect(batch.set).toHaveBeenCalled()
  })

  it('allows a new invite when comfortably under the limit', async () => {
    stubSession()
    const { batch } = wire({ memberCount: 1, pendingCount: 0, expiredCount: 0, limit: 5 })

    const result = await inviteUsers([EMAIL], 'crew')

    expect(result.error).toBeUndefined()
    expect(batch.set).toHaveBeenCalled()
  })

  it('skips the guard and logs when subscription.limits.users is missing', async () => {
    stubSession()
    const docs: DocMap = {
      [`companies/${COMPANY_ID}/members/admin-1`]: { name: 'Admin One' },
      [`companies/${COMPANY_ID}`]: { name: 'Nordfilm AB' }, // no subscription field
    }
    const query: QueryResolver = () => []
    const { batch } = wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await inviteUsers([EMAIL], 'crew')

    expect(result.error).toBeUndefined()
    expect(batch.set).toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      '[actions/team]',
      expect.objectContaining({ action: 'invite_users_seat_guard' }),
    )
    errorSpy.mockRestore()
  })
})
