/**
 * Operator views render every date in UTC (issue #292). The fixtures below are
 * fixed instants and the suite never sets `TZ` — the assertions must hold
 * whatever zone the machine runs in. Run it under `TZ=Europe/Stockholm` and
 * `TZ=America/Los_Angeles` to see the guard bite: a zone-less format would
 * show 11 SEP / 15:42 / 07:42 here.
 */

import { describe, it, expect } from 'vitest'
import {
  OPERATOR_ZONE,
  formatOperatorDate,
  formatOperatorDateTime,
  formatOperatorMonthYear,
  formatOperatorShortDate,
  formatOperatorTime,
  isSameOperatorDay,
  monthsSinceOperator,
} from '@/lib/operatorDates'

// The case from the issue: 22:42 UTC is already 11 Sep in Stockholm.
const ISSUE_INSTANT = '2026-09-10T22:42:13.150Z'
const NEW_YEARS_EVE = '2026-12-31T23:30:00Z'
const AFTERNOON = '2026-09-05T14:32:00Z'

describe('operatorDates', () => {
  it('uses UTC as the operator zone', () => {
    expect(OPERATOR_ZONE).toBe('UTC')
  })

  describe('formatOperatorDate', () => {
    it('renders the UTC calendar date, never the machine-local one', () => {
      expect(formatOperatorDate(ISSUE_INSTANT)).toBe('10 Sep 2026')
    })

    it('spells September "Sep" regardless of ICU ("Sept" in newer en-GB data)', () => {
      expect(formatOperatorDate(AFTERNOON)).toBe('05 Sep 2026')
    })

    it('stays on the old year across the year boundary', () => {
      expect(formatOperatorDate(NEW_YEARS_EVE)).toBe('31 Dec 2026')
    })
  })

  describe('formatOperatorMonthYear', () => {
    it('renders upper-case month and year in UTC', () => {
      expect(formatOperatorMonthYear(ISSUE_INSTANT)).toBe('SEP 2026')
      expect(formatOperatorMonthYear(NEW_YEARS_EVE)).toBe('DEC 2026')
    })
  })

  describe('formatOperatorShortDate', () => {
    it('renders zero-padded day and upper-case month in UTC', () => {
      expect(formatOperatorShortDate(AFTERNOON)).toBe('05 SEP')
      expect(formatOperatorShortDate(ISSUE_INSTANT)).toBe('10 SEP')
    })
  })

  describe('formatOperatorDateTime / formatOperatorTime', () => {
    it('renders UTC hours and minutes', () => {
      expect(formatOperatorDateTime(AFTERNOON)).toBe('05 SEP 2026 · 14:32')
      expect(formatOperatorTime(AFTERNOON)).toBe('14:32')
    })

    it('keeps the date and the time on the same UTC side of midnight', () => {
      expect(formatOperatorDateTime(ISSUE_INSTANT)).toBe('10 SEP 2026 · 22:42')
      expect(formatOperatorDateTime(NEW_YEARS_EVE)).toBe('31 DEC 2026 · 23:30')
    })

    it('renders midnight as 00:xx, not 24:xx', () => {
      expect(formatOperatorTime('2026-09-10T00:05:00Z')).toBe('00:05')
    })
  })

  describe('isSameOperatorDay', () => {
    it('compares UTC calendar dates around midnight', () => {
      const lateEvening = new Date('2026-09-10T23:59:59Z')
      expect(isSameOperatorDay(lateEvening, new Date('2026-09-10T00:00:00Z'))).toBe(true)
      expect(isSameOperatorDay(lateEvening, new Date('2026-09-11T00:00:00Z'))).toBe(false)
    })

    it('distinguishes the same day of a different month or year', () => {
      expect(isSameOperatorDay(new Date('2026-09-10T12:00:00Z'), new Date('2026-10-10T12:00:00Z'))).toBe(false)
      expect(isSameOperatorDay(new Date('2026-09-10T12:00:00Z'), new Date('2027-09-10T12:00:00Z'))).toBe(false)
    })
  })

  describe('monthsSinceOperator', () => {
    it('counts UTC calendar months, so 31 Dec 23:30Z to 1 Jan 00:30Z is one month', () => {
      expect(monthsSinceOperator(NEW_YEARS_EVE, new Date('2027-01-01T00:30:00Z'))).toBe(1)
    })

    it('counts across a year boundary and within a month', () => {
      expect(monthsSinceOperator('2025-11-15T12:00:00Z', new Date('2026-02-01T00:00:00Z'))).toBe(3)
      expect(monthsSinceOperator('2026-09-01T00:00:00Z', new Date('2026-09-30T23:59:59Z'))).toBe(0)
    })

    it('never goes negative', () => {
      expect(monthsSinceOperator('2027-01-01T00:00:00Z', new Date('2026-09-10T00:00:00Z'))).toBe(0)
    })
  })

  describe('missing or invalid input', () => {
    it.each([null, undefined, '', 'garbage'])('renders %j as an em dash', (input) => {
      expect(formatOperatorDate(input)).toBe('—')
      expect(formatOperatorMonthYear(input)).toBe('—')
      expect(formatOperatorShortDate(input)).toBe('—')
      expect(formatOperatorDateTime(input)).toBe('—')
    })
  })
})
