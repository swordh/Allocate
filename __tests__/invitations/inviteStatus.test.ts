/**
 * lib/invite-status.ts — inviteMeta + daysLeftFrom (commit 5, redesign phase 2).
 *
 * Client-safe (no `import 'server-only'`) — commit 10's team section reads
 * this directly from a client component. Covers the design's four exact
 * status strings.
 */

import { describe, it, expect } from 'vitest'
import { inviteMeta, daysLeftFrom } from '@/lib/invite-status'
import type { Invitation } from '@/types/invitation'

const NOW = Date.parse('2026-08-05T12:00:00.000Z')

function invite(overrides: Partial<Invitation>): Pick<Invitation, 'invitedAt' | 'expiresAt' | 'lastSentAt' | 'status'> {
  return {
    invitedAt: '2026-08-02T12:00:00.000Z',
    status: 'pending',
    ...overrides,
  }
}

describe('inviteMeta', () => {
  it('"Sent N days ago" for a legacy invite with no expiresAt', () => {
    const result = inviteMeta(invite({ invitedAt: '2026-08-02T12:00:00.000Z' }), NOW)
    expect(result.state).toBe('active')
    expect(result.text).toBe('Sent 3 days ago')
  })

  it('"Sent N days ago · expires in N days" when expiresAt is set and not expired', () => {
    const result = inviteMeta(
      invite({
        invitedAt: '2026-07-24T12:00:00.000Z', // 12 days ago
        expiresAt: '2026-08-07T12:00:00.000Z', // 2 days left
      }),
      NOW,
    )
    expect(result.state).toBe('active')
    expect(result.text).toBe('Sent 12 days ago · expires in 2 days')
  })

  it('"Expired <date> — resend to try again" once expiresAt has passed', () => {
    const result = inviteMeta(
      invite({
        invitedAt: '2026-07-12T12:00:00.000Z',
        expiresAt: '2026-07-19T12:00:00.000Z',
      }),
      NOW,
    )
    expect(result.state).toBe('expired')
    expect(result.text).toBe('Expired Jul 19 — resend to try again')
  })

  it('"Invite re-sent just now" when lastSentAt is within the last minute', () => {
    const result = inviteMeta(
      invite({
        expiresAt: '2026-07-01T00:00:00.000Z', // would otherwise read as expired
        lastSentAt: '2026-08-05T11:59:30.000Z', // 30s before NOW
      }),
      NOW,
    )
    expect(result.state).toBe('resent')
    expect(result.text).toBe('Invite re-sent just now')
  })

  it('does not treat an older lastSentAt as "just now"', () => {
    const result = inviteMeta(
      invite({
        invitedAt: '2026-08-02T12:00:00.000Z',
        lastSentAt: '2026-08-05T11:00:00.000Z', // an hour before NOW
      }),
      NOW,
    )
    expect(result.state).toBe('active')
    expect(result.text).toBe('Sent 3 days ago')
  })

  it('singularizes "1 day ago" / "expires in 1 day"', () => {
    const result = inviteMeta(
      invite({
        invitedAt: '2026-08-04T12:00:00.000Z', // 1 day ago
        expiresAt: '2026-08-06T12:00:00.000Z', // 1 day left
      }),
      NOW,
    )
    expect(result.text).toBe('Sent 1 day ago · expires in 1 day')
  })
})

describe('daysLeftFrom', () => {
  it('returns 0 rather than negative once expired', () => {
    expect(daysLeftFrom('2026-07-01T00:00:00.000Z', NOW)).toBe(0)
  })
})
