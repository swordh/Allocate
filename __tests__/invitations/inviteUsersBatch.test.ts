/**
 * inviteUsers — batch writes and the seat-guard regression.
 *
 * The single most important test in this file: 10 addresses against 1 free
 * seat must return an error and call `batch.set` ZERO times. The old
 * per-address seat guard evaluated a `count()` aggregate in a loop, which is
 * blind to writes staged earlier in the same uncommitted batch — that let N
 * invitations through against a single free seat. `inviteUsers` guards ONCE,
 * against a snapshot plus the size of the whole batch, before writing anything.
 *
 * Also covers: one commit for N addresses, 3 writes per created address
 * (invite doc + mirror doc + mail doc, all via `batch.set` — no `.add()`),
 * distinct tokens per address, the mail document's payload, and a batch
 * mixing new and skipped addresses.
 *
 * Assertions are on payloads, not ref paths — wireDb's `chain['doc']`
 * returns `${path}/auto-id` for every generated ref, so with several invite
 * docs in one batch the refs are indistinguishable from each other.
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

function wire({ memberCount, limit }: { memberCount: number; limit: number }) {
  const docs: DocMap = {
    [`companies/${COMPANY_ID}/members/admin-1`]: { name: 'Admin One' },
    [`companies/${COMPANY_ID}`]: {
      name: 'Nordfilm AB',
      subscription: { limits: { users: limit } },
    },
  }
  const query: QueryResolver = (ctx) => {
    if (ctx.path === `companies/${COMPANY_ID}/members`) {
      return Array.from({ length: memberCount }, (_, i) => ({ id: `m${i}`, data: { email: `m${i}@x.se` } }))
    }
    return [] // no pending invitations
  }
  return wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })
}

describe('inviteUsers — batch writes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T00:00:00.000Z'))
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.allocate.at'
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('REGRESSION: 10 addresses against 1 free seat — error, zero writes', async () => {
    stubSession()
    // limit 5, 4 members already → exactly 1 seat left.
    const { batch } = wire({ memberCount: 4, limit: 5 })

    const emails = Array.from({ length: 10 }, (_, i) => `person${i}@example.com`)
    const result = await inviteUsers(emails, 'crew')

    expect(result.error).toMatch(/seat limit reached/i)
    expect(result.invitations).toBeUndefined()
    expect(batch.set).toHaveBeenCalledTimes(0)
    expect(batch.commit).not.toHaveBeenCalled()
  })

  it('commits once for N addresses with 3 writes per created address', async () => {
    stubSession()
    const { batch } = wire({ memberCount: 0, limit: 100 })

    const emails = ['a@example.com', 'b@example.com', 'c@example.com']
    const result = await inviteUsers(emails, 'admin')

    expect(result.error).toBeUndefined()
    expect(result.invitations).toHaveLength(3)
    expect(batch.set).toHaveBeenCalledTimes(9) // 3 per address: invite + mirror + mail
    expect(batch.commit).toHaveBeenCalledTimes(1)
  })

  it('gives every address its own distinct token', async () => {
    stubSession()
    const { batch } = wire({ memberCount: 0, limit: 100 })

    const emails = ['a@example.com', 'b@example.com', 'c@example.com']
    const result = await inviteUsers(emails, 'crew')

    // Tokens aren't on PublicInvitation, but they ARE embedded in each
    // mail doc's acceptUrl — extract and check for distinctness there.
    const setCalls = batch.set.mock.calls as [unknown, Record<string, unknown>][]
    const mailPayloads = setCalls
      .map(([, data]) => data)
      .filter((data): data is { template: string; data: { acceptUrl: string } } => data.template === 'invitation')

    expect(mailPayloads).toHaveLength(3)
    const tokens = mailPayloads.map((m) => m.data.acceptUrl.split('/invite/')[1])
    expect(new Set(tokens).size).toBe(3)
    expect(result.invitations).toHaveLength(3)
  })

  it('sends the correct mail document payload per address', async () => {
    stubSession()
    const { batch } = wire({ memberCount: 0, limit: 100 })

    await inviteUsers(['newperson@example.com'], 'viewer')

    expect(batch.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        to: 'newperson@example.com',
        template: 'invitation',
        status: 'queued',
        data: expect.objectContaining({
          companyName: 'Nordfilm AB',
          role: 'viewer',
          acceptUrl: expect.stringContaining('/invite/'),
        }),
      }),
    )
  })

  it('mixes new and skipped addresses within a single batch, seat guard counts only the new ones', async () => {
    stubSession()
    const alreadyInvited = 'pending@example.com'
    const docs: DocMap = {
      [`companies/${COMPANY_ID}/members/admin-1`]: { name: 'Admin One' },
      [`companies/${COMPANY_ID}`]: {
        name: 'Nordfilm AB',
        subscription: { limits: { users: 10 } },
      },
    }
    const query: QueryResolver = (ctx) => {
      if (ctx.path === `companies/${COMPANY_ID}/members`) return []
      if (ctx.path === `companies/${COMPANY_ID}/invitations`) {
        return [{ id: 'invite-1', data: { email: alreadyInvited, status: 'pending' } }]
      }
      return []
    }
    const { batch } = wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })

    const result = await inviteUsers([alreadyInvited, 'new1@example.com', 'new2@example.com'], 'crew')

    expect(result.error).toBeUndefined()
    expect(result.skipped).toEqual([{ email: alreadyInvited, reason: 'invited' }])
    expect(result.invitations).toHaveLength(2)
    expect(batch.set).toHaveBeenCalledTimes(6) // 3 writes × 2 created addresses only
  })
})
