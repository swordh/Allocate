/**
 * inviteUsers — create branch (role allowlist).
 *
 * Covers the role allowlist: the submitted role must be one of
 * 'admin' | 'crew' | 'viewer', with 'crew' as the fallback for an invalid
 * value. Never trust the client value without this check.
 *
 * Asserts on the batch.set PAYLOAD, not the ref path — wireDb's
 * `chain['doc']` returns `${path}/auto-id` for every generated ref, so with
 * more than one address in a batch the refs are indistinguishable. Payloads
 * (email, role, token, ...) are the only thing worth asserting on.
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
import type { Role } from '@/types'

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

function wire() {
  const docs: DocMap = {
    [`companies/${COMPANY_ID}/members/admin-1`]: { name: 'Admin One' },
    // No subscription field — seat guard should log and skip rather than block.
    [`companies/${COMPANY_ID}`]: { name: 'Nordfilm AB' },
  }

  const query: QueryResolver = () => [] // no members, no pending invites

  return wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })
}

describe('inviteUsers — create branch (role allowlist)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T00:00:00.000Z'))
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.allocate.at'
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('accepts a submitted role of admin', async () => {
    stubSession()
    const { batch } = wire()

    const result = await inviteUsers([EMAIL], 'admin')

    expect(result.error).toBeUndefined()
    expect(result.invitations).toHaveLength(1)
    expect(batch.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: EMAIL, role: 'admin' }),
    )
  })

  it('accepts a submitted role of viewer', async () => {
    stubSession()
    const { batch } = wire()

    const result = await inviteUsers([EMAIL], 'viewer')

    expect(result.error).toBeUndefined()
    expect(batch.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: EMAIL, role: 'viewer' }),
    )
  })

  it('falls back to crew for an invalid role value', async () => {
    stubSession()
    const { batch } = wire()

    const result = await inviteUsers([EMAIL], 'owner' as Role)

    expect(result.error).toBeUndefined()
    expect(batch.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: EMAIL, role: 'crew' }),
    )
  })

  it('normalizes email casing and whitespace before storing', async () => {
    stubSession()
    const { batch } = wire()

    const result = await inviteUsers(['  New.Crew@Example.com  '], 'crew')

    expect(result.error).toBeUndefined()
    expect(batch.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: 'new.crew@example.com' }),
    )
  })

  it('rejects an empty recipient list', async () => {
    stubSession()
    wire()

    const result = await inviteUsers([], 'crew')

    expect(result.error).toMatch(/at least one/i)
  })

  it('rejects a batch over MAX_RECIPIENTS', async () => {
    stubSession()
    const { batch } = wire()

    const emails = Array.from({ length: 26 }, (_, i) => `person${i}@example.com`)
    const result = await inviteUsers(emails, 'crew')

    expect(result.error).toMatch(/too many recipients/i)
    expect(batch.set).not.toHaveBeenCalled()
  })
})
