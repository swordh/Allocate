/**
 * revokeInvitation — WP6.
 *
 * Admin-only. Reads the private doc first (never trusts a token from the
 * client), refuses non-pending invites, and batch-updates both the private
 * doc and the public mirror.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: { doc: vi.fn(), collection: vi.fn(), batch: vi.fn() },
  adminAuth: {},
}))

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { revokeInvitation } from '@/actions/team'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { wireDb, type DocMap } from '../helpers/firestore'

const COMPANY_ID = 'company-A'
const INVITE_ID = 'invite-1'
const TOKEN = 'abc123def456ghi789jkl012mno345pq'

function stubSession(role: 'admin' | 'crew' = 'admin') {
  vi.mocked(getVerifiedSession).mockResolvedValue({
    uid: 'admin-1',
    email: 'admin@example.com',
    activeCompanyId: COMPANY_ID,
    role,
  })
}

function wire(docs: DocMap) {
  return wireDb(adminDb as unknown as Record<string, unknown>, { docs })
}

describe('revokeInvitation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects a non-admin caller', async () => {
    stubSession('crew')
    const { batch } = wire({
      [`companies/${COMPANY_ID}/invitations/${INVITE_ID}`]: {
        status: 'pending',
        token: TOKEN,
      },
    })

    const result = await revokeInvitation(INVITE_ID)

    expect(result.error).toBe('Unauthorized')
    expect(batch.commit).not.toHaveBeenCalled()
  })

  it('rejects an invite that is not pending', async () => {
    stubSession('admin')
    const { batch } = wire({
      [`companies/${COMPANY_ID}/invitations/${INVITE_ID}`]: {
        status: 'accepted',
        token: TOKEN,
      },
    })

    const result = await revokeInvitation(INVITE_ID)

    expect(result.error).toBe('Only pending invitations can be revoked')
    expect(batch.commit).not.toHaveBeenCalled()
  })

  it('returns an error when the invite does not exist', async () => {
    stubSession('admin')
    wire({ [`companies/${COMPANY_ID}/invitations/${INVITE_ID}`]: null })

    const result = await revokeInvitation(INVITE_ID)

    expect(result.error).toBe('Invitation not found')
  })

  it('marks the private doc revoked and deletes the mirror', async () => {
    stubSession('admin')
    const { batch } = wire({
      [`companies/${COMPANY_ID}/invitations/${INVITE_ID}`]: {
        status: 'pending',
        token: TOKEN,
      },
      [`invitations/${TOKEN}`]: { status: 'pending' },
    })

    const result = await revokeInvitation(INVITE_ID)

    expect(result.error).toBeUndefined()
    expect(batch.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: `companies/${COMPANY_ID}/invitations/${INVITE_ID}` }),
      expect.objectContaining({ status: 'revoked', revokedBy: 'admin-1' }),
    )
    // Issue #410: a revoked private doc is never read again, so it gets a
    // concrete `expireAt` Timestamp for the TTL policy to clean it up 30
    // days later.
    expect(batch.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: `companies/${COMPANY_ID}/invitations/${INVITE_ID}` }),
      expect.objectContaining({ expireAt: expect.any(Timestamp) }),
    )
    // Issue #297: the mirror is deleted, not marked 'revoked' — it's a
    // publicly readable doc carrying the invitee's email, and a revoked
    // invite can never be used again.
    expect(batch.delete).toHaveBeenCalledWith(expect.objectContaining({ path: `invitations/${TOKEN}` }))
    expect(batch.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: `invitations/${TOKEN}` }),
      expect.anything(),
    )
    expect(batch.commit).toHaveBeenCalledOnce()
  })
})
