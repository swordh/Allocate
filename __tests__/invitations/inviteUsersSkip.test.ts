/**
 * inviteUsers — skip branch.
 *
 * There is no resend fallback in `inviteUsers` (that branch was removed
 * along with single-address `inviteUser`). An address that is already a
 * member, or already has a `status == 'pending'` invite (regardless of
 * expiry), is skipped and reported back — never resent, no write for it.
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
import { wireDb, type DocMap, type QueryResolver } from '../helpers/firestore'

const COMPANY_ID = 'company-A'

function stubSession() {
  vi.mocked(getVerifiedSession).mockResolvedValue({
    uid: 'admin-1',
    email: 'admin@example.com',
    activeCompanyId: COMPANY_ID,
    role: 'admin',
  })
}

describe('inviteUsers — skip branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T00:00:00.000Z'))
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.allocate.at'
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('skips an address with an existing pending invite — even if expired', async () => {
    stubSession()
    const email = 'already-invited@example.com'
    const docs: DocMap = {
      [`companies/${COMPANY_ID}/members/admin-1`]: { name: 'Admin One' },
      [`companies/${COMPANY_ID}`]: { name: 'Nordfilm AB' },
    }
    const query: QueryResolver = (ctx) => {
      if (ctx.path === `companies/${COMPANY_ID}/members`) return []
      if (ctx.path === `companies/${COMPANY_ID}/invitations`) {
        return [
          {
            id: 'invite-1',
            data: { email, status: 'pending', expiresAt: '2020-01-01T00:00:00.000Z' }, // expired, still skipped
          },
        ]
      }
      return []
    }
    const { batch } = wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })

    const result = await inviteUsers([email], 'crew')

    expect(result.error).toBeUndefined()
    expect(result.invitations).toEqual([])
    expect(result.skipped).toEqual([{ email, reason: 'invited' }])
    expect(batch.set).not.toHaveBeenCalled()
    expect(batch.commit).not.toHaveBeenCalled()
  })

  it('skips an address that already belongs to a member', async () => {
    stubSession()
    const email = 'existing-member@example.com'
    const docs: DocMap = {
      [`companies/${COMPANY_ID}/members/admin-1`]: { name: 'Admin One' },
      [`companies/${COMPANY_ID}`]: { name: 'Nordfilm AB' },
    }
    const query: QueryResolver = (ctx) => {
      if (ctx.path === `companies/${COMPANY_ID}/members`) {
        return [{ id: 'member-1', data: { email } }]
      }
      return []
    }
    const { batch } = wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })

    const result = await inviteUsers([email], 'crew')

    expect(result.error).toBeUndefined()
    expect(result.invitations).toEqual([])
    expect(result.skipped).toEqual([{ email, reason: 'member' }])
    expect(batch.set).not.toHaveBeenCalled()
  })

  it('mixes a skipped address with a new one in the same batch', async () => {
    stubSession()
    const invitedEmail = 'pending@example.com'
    const newEmail = 'brandnew@example.com'
    const docs: DocMap = {
      [`companies/${COMPANY_ID}/members/admin-1`]: { name: 'Admin One' },
      [`companies/${COMPANY_ID}`]: { name: 'Nordfilm AB' },
    }
    const query: QueryResolver = (ctx) => {
      if (ctx.path === `companies/${COMPANY_ID}/members`) return []
      if (ctx.path === `companies/${COMPANY_ID}/invitations`) {
        return [{ id: 'invite-1', data: { email: invitedEmail, status: 'pending' } }]
      }
      return []
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })

    const result = await inviteUsers([invitedEmail, newEmail], 'crew')

    expect(result.error).toBeUndefined()
    expect(result.skipped).toEqual([{ email: invitedEmail, reason: 'invited' }])
    expect(result.invitations).toHaveLength(1)
    expect(result.invitations?.[0].email).toBe(newEmail)
  })
})
