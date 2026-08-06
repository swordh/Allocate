/**
 * inviteUser — create branch (commit 5, redesign phase 2).
 *
 * Covers the role allowlist: the submitted role must be one of
 * 'admin' | 'crew' | 'viewer', with 'crew' as the fallback for a
 * missing/invalid value. Never trust the client value without this check.
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
import { wireDb, type DocMap, type QueryResolver } from '../helpers/firestore'

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

  const query: QueryResolver = () => [] // no existing member, no pending invite

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

function makeFormData(email: string, role?: string): FormData {
  const fd = new FormData()
  fd.set('email', email)
  if (role !== undefined) fd.set('role', role)
  return fd
}

describe('inviteUser — create branch (role allowlist)', () => {
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

    const result = await inviteUser(makeFormData(EMAIL, 'admin'))

    expect(result.error).toBeUndefined()
    expect(batch.set).toHaveBeenCalledWith(
      expect.objectContaining({ path: `companies/${COMPANY_ID}/invitations/auto-id` }),
      expect.objectContaining({ role: 'admin' }),
    )
  })

  it('accepts a submitted role of viewer', async () => {
    stubSession()
    const { batch } = wire()

    const result = await inviteUser(makeFormData(EMAIL, 'viewer'))

    expect(result.error).toBeUndefined()
    expect(batch.set).toHaveBeenCalledWith(
      expect.objectContaining({ path: `companies/${COMPANY_ID}/invitations/auto-id` }),
      expect.objectContaining({ role: 'viewer' }),
    )
  })

  it('falls back to crew for an invalid role value', async () => {
    stubSession()
    const { batch } = wire()

    const result = await inviteUser(makeFormData(EMAIL, 'owner'))

    expect(result.error).toBeUndefined()
    expect(batch.set).toHaveBeenCalledWith(
      expect.objectContaining({ path: `companies/${COMPANY_ID}/invitations/auto-id` }),
      expect.objectContaining({ role: 'crew' }),
    )
  })

  it('falls back to crew when no role is submitted', async () => {
    stubSession()
    const { batch } = wire()

    const result = await inviteUser(makeFormData(EMAIL))

    expect(result.error).toBeUndefined()
    expect(batch.set).toHaveBeenCalledWith(
      expect.objectContaining({ path: `companies/${COMPANY_ID}/invitations/auto-id` }),
      expect.objectContaining({ role: 'crew' }),
    )
  })
})
