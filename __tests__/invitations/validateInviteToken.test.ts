/**
 * validateInviteToken — WP5.
 *
 * Deliberately session-less: the 128-bit token is the bearer credential.
 * Covers the three input shapes (URL path, ?token= query, raw token), every
 * failure reason, and the backward-compat rule that a legacy invite with no
 * `expiresAt` is still valid.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: { doc: vi.fn(), collection: vi.fn() },
  adminAuth: {},
}))

import { validateInviteToken } from '@/actions/invitations'
import { adminDb } from '@/lib/firebase-admin'
import { wireDb, type DocMap } from '../helpers/firestore'

const TOKEN = 'abc123def456ghi789jkl012mno345pq'
const COMPANY_ID = 'company-A'
const INVITE_ID = 'invite-1'

function wire(overrides: { docs?: DocMap } = {}) {
  const docs: DocMap = {
    [`invitations/${TOKEN}`]: {
      companyId: COMPANY_ID,
      inviteId: INVITE_ID,
      email: 'crew@example.com',
      status: 'pending',
    },
    [`companies/${COMPANY_ID}/invitations/${INVITE_ID}`]: {
      id: INVITE_ID,
      email: 'crew@example.com',
      role: 'crew',
      invitedBy: 'admin-1',
      invitedByName: 'Admin One',
      invitedAt: '2026-08-01T00:00:00.000Z',
      status: 'pending',
      token: TOKEN,
      expiresAt: '2026-08-08T00:00:00.000Z',
    },
    [`companies/${COMPANY_ID}`]: { name: 'Nordfilm AB' },
    ...overrides.docs,
  }
  wireDb(adminDb as unknown as Record<string, unknown>, { docs })
}

describe('validateInviteToken', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('validates a raw token', async () => {
    wire()
    const result = await validateInviteToken(TOKEN)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.token).toBe(TOKEN)
      expect(result.companyName).toBe('Nordfilm AB')
      expect(result.role).toBe('crew')
      expect(result.email).toBe('crew@example.com')
      expect(result.daysLeft).toBe(3)
    }
  })

  it('validates the /invite/<token> URL form', async () => {
    wire()
    const result = await validateInviteToken(`https://allocate.at/invite/${TOKEN}`)
    expect(result.ok).toBe(true)
  })

  it('validates the ?token= query form', async () => {
    wire()
    const result = await validateInviteToken(`https://allocate.at/signup?token=${TOKEN}`)
    expect(result.ok).toBe(true)
  })

  it('rejects a malformed input', async () => {
    wire()
    const result = await validateInviteToken('not a valid token!! ***')
    expect(result).toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects an empty input as malformed', async () => {
    wire()
    const result = await validateInviteToken('   ')
    expect(result).toEqual({ ok: false, reason: 'malformed' })
  })

  it('returns not_found when the mirror doc is missing', async () => {
    wire({ docs: { [`invitations/${TOKEN}`]: null } })
    const result = await validateInviteToken(TOKEN)
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('returns not_found when the private doc is missing (mirror exists)', async () => {
    wire({ docs: { [`companies/${COMPANY_ID}/invitations/${INVITE_ID}`]: null } })
    const result = await validateInviteToken(TOKEN)
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('returns accepted for an already-accepted invite', async () => {
    wire({
      docs: {
        [`companies/${COMPANY_ID}/invitations/${INVITE_ID}`]: {
          id: INVITE_ID,
          email: 'crew@example.com',
          role: 'crew',
          invitedBy: 'admin-1',
          invitedByName: 'Admin One',
          invitedAt: '2026-08-01T00:00:00.000Z',
          status: 'accepted',
          token: TOKEN,
        },
      },
    })
    const result = await validateInviteToken(TOKEN)
    expect(result).toEqual({ ok: false, reason: 'accepted' })
  })

  it('returns revoked for a revoked invite', async () => {
    wire({
      docs: {
        [`companies/${COMPANY_ID}/invitations/${INVITE_ID}`]: {
          id: INVITE_ID,
          email: 'crew@example.com',
          role: 'crew',
          invitedBy: 'admin-1',
          invitedByName: 'Admin One',
          invitedAt: '2026-08-01T00:00:00.000Z',
          status: 'revoked',
          token: TOKEN,
        },
      },
    })
    const result = await validateInviteToken(TOKEN)
    expect(result).toEqual({ ok: false, reason: 'revoked' })
  })

  it('returns expired when expiresAt has passed', async () => {
    wire({
      docs: {
        [`companies/${COMPANY_ID}/invitations/${INVITE_ID}`]: {
          id: INVITE_ID,
          email: 'crew@example.com',
          role: 'crew',
          invitedBy: 'admin-1',
          invitedByName: 'Admin One',
          invitedAt: '2026-07-01T00:00:00.000Z',
          status: 'pending',
          token: TOKEN,
          expiresAt: '2026-07-08T00:00:00.000Z',
        },
      },
    })
    const result = await validateInviteToken(TOKEN)
    expect(result).toEqual({ ok: false, reason: 'expired' })
  })

  it('validates a legacy invite with no expiresAt (never expires)', async () => {
    wire({
      docs: {
        [`companies/${COMPANY_ID}/invitations/${INVITE_ID}`]: {
          id: INVITE_ID,
          email: 'crew@example.com',
          role: 'crew',
          invitedBy: 'admin-1',
          invitedByName: 'Admin One',
          invitedAt: '2026-01-01T00:00:00.000Z',
          status: 'pending',
          token: TOKEN,
          // no expiresAt — pre-dates the TTL field
        },
      },
    })
    const result = await validateInviteToken(TOKEN)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.expiresAt).toBeNull()
      expect(result.daysLeft).toBeNull()
    }
  })
})
