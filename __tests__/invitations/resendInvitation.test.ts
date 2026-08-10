/**
 * resendInvitation — dedicated resend action (commit 5, redesign phase 2).
 *
 * Extracted out of inviteUser's fallback so the team page's per-row RESEND
 * button doesn't have to re-post the whole invite form. Must read the token
 * from the private doc server-side (never accept one from the client), be
 * admin-guarded, and require status === 'pending'.
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

import { resendInvitation } from '@/actions/team'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { wireDb, type DocMap } from '../helpers/firestore'

const COMPANY_ID = 'company-A'
const INVITE_ID = 'invite-1'
const TOKEN = 'existingtoken0123456789abcdef01'
const EMAIL = 'crew@example.com'

function stubSession(role: 'admin' | 'crew' | 'viewer' = 'admin') {
  vi.mocked(getVerifiedSession).mockResolvedValue({
    uid: 'admin-1',
    email: 'admin@example.com',
    activeCompanyId: COMPANY_ID,
    role,
  })
}

function wire(inviteOverrides: Record<string, unknown> = {}) {
  const docs: DocMap = {
    [`companies/${COMPANY_ID}/invitations/${INVITE_ID}`]: {
      id: INVITE_ID,
      email: EMAIL,
      role: 'crew',
      invitedBy: 'admin-1',
      invitedByName: 'Admin One',
      invitedAt: '2026-07-28T00:00:00.000Z',
      status: 'pending',
      token: TOKEN,
      expiresAt: '2026-08-04T00:00:00.000Z', // already expired — resend should still work
      ...inviteOverrides,
    },
    [`companies/${COMPANY_ID}`]: { name: 'Nordfilm AB' },
  }

  const wired = wireDb(adminDb as unknown as Record<string, unknown>, { docs })

  const innerCollection = wired.collection as unknown as (path: string) => Record<string, unknown>
  const collectionWithAdd = vi.fn((path: string) => {
    const chain = innerCollection(path)
    chain['add'] = vi.fn().mockResolvedValue({ id: 'mail-1' })
    return chain
  })
  ;(adminDb as unknown as Record<string, unknown>)['collection'] = collectionWithAdd

  return wired
}

describe('resendInvitation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T00:00:00.000Z'))
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.allocate.at'
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects a non-admin caller', async () => {
    stubSession('crew')
    wire()

    const result = await resendInvitation(INVITE_ID)

    expect(result.error).toBe('Unauthorized')
  })

  it('rejects an unknown invitation', async () => {
    stubSession()
    wireDb(adminDb as unknown as Record<string, unknown>, { docs: {} })

    const result = await resendInvitation('missing')

    expect(result.error).toBe('Invitation not found')
  })

  it('rejects a non-pending invitation', async () => {
    stubSession()
    wire({ status: 'accepted' })

    const result = await resendInvitation(INVITE_ID)

    expect(result.error).toMatch(/only pending/i)
  })

  it('extends expiresAt, stamps lastSentAt, and re-queues the email', async () => {
    stubSession()
    const { batch } = wire()

    const result = await resendInvitation(INVITE_ID)

    expect(result.error).toBeUndefined()
    expect(batch.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: `companies/${COMPANY_ID}/invitations/${INVITE_ID}` }),
      { expiresAt: '2026-08-12T00:00:00.000Z', lastSentAt: '2026-08-05T00:00:00.000Z' },
    )
    expect(batch.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: `invitations/${TOKEN}` }),
      { expiresAt: '2026-08-12T00:00:00.000Z' },
    )
    expect(batch.commit).toHaveBeenCalled()
  })

  it('never trusts a client-supplied token — always reads it from the private doc', async () => {
    // Regardless of what inviteId resolves to, the token used for the mirror
    // update must come from the fetched invite doc's `token` field, not from
    // any client input (resendInvitation's signature doesn't even accept one).
    stubSession()
    const { batch } = wire()

    await resendInvitation(INVITE_ID)

    const mirrorUpdateCall = batch.update.mock.calls.find(
      (call: unknown[]) => (call[0] as { path: string }).path === `invitations/${TOKEN}`,
    )
    expect(mirrorUpdateCall).toBeDefined()
  })
})
