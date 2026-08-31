/**
 * lib/invite-recipients.ts — seatPreview.
 *
 * Covers classification precedence (member beats invited beats new), the
 * `seatLimit: null` (no limit enforced) case, the `canSubmit === false`
 * guard when there are zero new addresses, and the three copy strings
 * (button label, info line, over-limit warning).
 */

import { describe, it, expect } from 'vitest'
import { seatPreview } from '@/lib/invite-recipients'

describe('seatPreview', () => {
  it('classifies member ahead of invited when an address is in both sets', () => {
    const result = seatPreview({
      emails: ['dup@x.se'],
      members: new Set(['dup@x.se']),
      invited: new Set(['dup@x.se']),
      seatsUsed: 0,
      seatLimit: null,
    })

    expect(result.recipients).toEqual([{ email: 'dup@x.se', state: 'member' }])
    expect(result.memberCount).toBe(1)
    expect(result.invitedCount).toBe(0)
  })

  it('treats seatLimit: null as unlimited — never over the limit', () => {
    const result = seatPreview({
      emails: Array.from({ length: 40 }, (_, i) => `p${i}@x.se`),
      members: new Set(),
      invited: new Set(),
      seatsUsed: 1000,
      seatLimit: null,
    })

    expect(result.seatsLeft).toBeNull()
    expect(result.overLimit).toBe(false)
    expect(result.canSubmit).toBe(true)
    expect(result.warning).toBeNull()
  })

  it('blocks submit when newCount is zero, even without a seat limit', () => {
    const result = seatPreview({
      emails: ['already@x.se'],
      members: new Set(),
      invited: new Set(['already@x.se']),
      seatsUsed: 0,
      seatLimit: null,
    })

    expect(result.newCount).toBe(0)
    expect(result.canSubmit).toBe(false)
  })

  /**
   * The empty field is the state this row spends most of its life in, and it
   * was the one case no test covered — `newCount === 1` shipped a literal
   * "SEND 0 INVITES" onto the default team-settings screen.
   */
  it('reads SEND INVITE, not "SEND 0 INVITES", when nothing has been entered', () => {
    const result = seatPreview({
      emails: [],
      members: new Set(),
      invited: new Set(),
      seatsUsed: 0,
      seatLimit: null,
    })

    expect(result.buttonLabel).toBe('SEND INVITE')
    expect(result.canSubmit).toBe(false)
    expect(result.infoLine).toBeNull()
  })

  it('produces the exact button label for a single new recipient', () => {
    const result = seatPreview({
      emails: ['a@x.se'],
      members: new Set(),
      invited: new Set(),
      seatsUsed: 0,
      seatLimit: null,
    })

    expect(result.buttonLabel).toBe('SEND INVITE')
  })

  it('produces the exact button label and info line for a mixed batch', () => {
    const emails = [
      ...Array.from({ length: 8 }, (_, i) => `new${i}@x.se`),
      'invited0@x.se',
      'invited1@x.se',
    ]
    const result = seatPreview({
      emails,
      members: new Set(),
      invited: new Set(['invited0@x.se', 'invited1@x.se']),
      seatsUsed: 0,
      seatLimit: null,
    })

    expect(result.buttonLabel).toBe('SEND 8 INVITES')
    expect(result.infoLine).toBe('10 invites · 2 are already invited.')
  })

  it('produces the exact over-limit warning text', () => {
    const emails = Array.from({ length: 8 }, (_, i) => `new${i}@x.se`)
    const result = seatPreview({
      emails,
      members: new Set(),
      invited: new Set(),
      seatsUsed: 2, // seatLimit 5 - seatsUsed 2 = 3 seats left
      seatLimit: 5,
    })

    expect(result.seatsLeft).toBe(3)
    expect(result.overLimit).toBe(true)
    expect(result.canSubmit).toBe(false)
    expect(result.warning).toBe('8 invites, 3 seats left. Remove 5 to send, or upgrade your plan.')
  })

  it('returns a null info line when there are no recipients', () => {
    const result = seatPreview({
      emails: [],
      members: new Set(),
      invited: new Set(),
      seatsUsed: 0,
      seatLimit: null,
    })

    expect(result.infoLine).toBeNull()
  })
})
