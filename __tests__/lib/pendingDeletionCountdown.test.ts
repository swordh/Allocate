/**
 * The countdown /no-company shows a stranded former member (issue #252
 * step 5, PR F — design brief "Del 3": "Nedräkningen ska gå att se, inte
 * bara stå i ett mail hon kanske missade"). Asserted at the string level,
 * not just "something renders" — a wrong word here (singular vs plural, or
 * a sentence that claims something untrue about her account) is exactly
 * the kind of thing a render-only test would miss.
 */

import { describe, it, expect } from 'vitest'
import { pendingDeletionCountdown } from '@/lib/pendingDeletionCountdown'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const now = Date.UTC(2026, 0, 1, 12, 0, 0) // fixed reference point

describe('pendingDeletionCountdown — counting down', () => {
  it('says "N days left" for a deadline several whole days out', () => {
    const state = pendingDeletionCountdown(new Date(now + 30 * MS_PER_DAY).toISOString(), now)
    expect(state).toEqual({
      kind:    'counting',
      label:   '30 days left',
      caption: 'until your account is deleted',
    })
  })

  it('says "1 day left" (singular) with just under one full day remaining', () => {
    const state = pendingDeletionCountdown(new Date(now + MS_PER_DAY - 1000).toISOString(), now)
    expect(state.kind).toBe('counting')
    expect(state).toHaveProperty('label', '1 day left')
  })

  // Mutation check for the ceil/floor choice: someone with 12 hours left
  // must still read "1 day left", not "0 days left" — rounding DOWN here
  // would understate how much time she actually has.
  it('rounds up: half a day remaining still reads "1 day left"', () => {
    const state = pendingDeletionCountdown(new Date(now + 12 * 60 * 60 * 1000).toISOString(), now)
    expect(state).toHaveProperty('label', '1 day left')
  })

  // Mutation check for the boundary: one second of remaining time is still
  // counting, not passed. If the `msLeft <= 0` comparison is loosened to
  // `< 0` or tightened to `<= MS_PER_DAY`, one of these two fails.
  it('is still counting with one second left', () => {
    const state = pendingDeletionCountdown(new Date(now + 1000).toISOString(), now)
    expect(state.kind).toBe('counting')
  })
})

/**
 * The sweep that executes a scheduled account deletion is deliberately
 * outside PR E and PR F, so from day 31 onwards this is the NORMAL state
 * of every stranded user — not a rare edge case. It used to render "Less
 * than a day left" in perpetuity, which is false.
 */
describe('pendingDeletionCountdown — deadline already passed', () => {
  it('gets its own state and wording, not a countdown', () => {
    const state = pendingDeletionCountdown(new Date(now - 5 * MS_PER_DAY).toISOString(), now)
    expect(state).toEqual({
      kind:    'passed',
      label:   'Deletion overdue',
      caption: 'your account passed its scheduled deletion date',
    })
  })

  it('treats the exact deadline instant as passed, never "0 days left"', () => {
    const state = pendingDeletionCountdown(new Date(now).toISOString(), now)
    expect(state.kind).toBe('passed')
  })

  // The bug this state replaces: the old module clamped with Math.max(0,…)
  // and fell into the sub-day label, so a long-expired deadline claimed
  // there was still time left. Assert the words are gone.
  it('never claims there is time left once the date has gone by', () => {
    const state = pendingDeletionCountdown(new Date(now - 400 * MS_PER_DAY).toISOString(), now)
    expect(JSON.stringify(state)).not.toContain('left')
  })
})

/**
 * Guard against "NaN days left". No current writer produces an empty or
 * unparseable `scheduledFor`, but nothing structurally prevents one, and
 * `new Date('').getTime()` is NaN.
 */
describe('pendingDeletionCountdown — unusable scheduledFor', () => {
  it.each([
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['a non-date string', 'sometime next month'],
  ])('returns { kind: "unknown" } for %s', (_label, value) => {
    expect(pendingDeletionCountdown(value as string | null | undefined, now))
      .toEqual({ kind: 'unknown' })
  })

  // Mutation check for the guard itself: without it these inputs produce a
  // label containing "NaN". Prove no reachable state can ever say that.
  it.each(['', 'not a date', '2026-13-45T99:99:99Z'])(
    'never produces a NaN label for %j',
    (value) => {
      expect(JSON.stringify(pendingDeletionCountdown(value, now))).not.toContain('NaN')
    },
  )
})
