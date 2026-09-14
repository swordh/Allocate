/**
 * The countdown text /no-company shows a stranded former member (issue
 * #252 step 5, PR F — design brief "Del 3": "Nedräkningen ska gå att se,
 * inte bara stå i ett mail hon kanske missade"). Asserted at the string
 * level, not just "something renders" — a wrong word here (singular vs
 * plural, "left" vs some other phrasing) is exactly the kind of thing a
 * render-only test would miss.
 */

import { describe, it, expect } from 'vitest'
import { daysLeftLabel } from '@/lib/pendingDeletionCountdown'

const MS_PER_DAY = 24 * 60 * 60 * 1000

describe('daysLeftLabel', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0) // fixed reference point

  it('says "N days left" for a deadline several whole days out', () => {
    const scheduledFor = new Date(now + 30 * MS_PER_DAY).toISOString()
    expect(daysLeftLabel(scheduledFor, now)).toBe('30 days left')
  })

  it('says "1 day left" (singular) with just under one full day remaining', () => {
    const scheduledFor = new Date(now + MS_PER_DAY - 1000).toISOString()
    expect(daysLeftLabel(scheduledFor, now)).toBe('1 day left')
  })

  // Mutation check for the ceil/floor choice: someone with 12 hours left
  // must still read "1 day left", not "0 days left" — rounding DOWN here
  // would understate how much time she actually has.
  it('rounds up: less than a full day still reads "1 day left"', () => {
    const scheduledFor = new Date(now + 12 * 60 * 60 * 1000).toISOString()
    expect(daysLeftLabel(scheduledFor, now)).toBe('1 day left')
  })

  it('says "Less than a day left" once the deadline is within the current instant', () => {
    const scheduledFor = new Date(now).toISOString()
    expect(daysLeftLabel(scheduledFor, now)).toBe('Less than a day left')
  })

  it('says "Less than a day left" for a deadline already in the past — never negative', () => {
    const scheduledFor = new Date(now - 5 * MS_PER_DAY).toISOString()
    expect(daysLeftLabel(scheduledFor, now)).toBe('Less than a day left')
  })
})
