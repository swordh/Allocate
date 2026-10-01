/**
 * `functions/src/company/format.ts` — issue #361 (explicit `timeZone` on
 * `formatDateFull`/`formatDateShort`, no implicit runtime zone) and issue
 * #334 (`formatRequesterDisplay`). Imported directly from functions/src the
 * same way __tests__/emailTemplates/*.test.ts already does — root vitest has
 * no compiled build step between it and that source.
 */
import { describe, it, expect } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import { formatDateFull, formatDateShort, formatRequesterDisplay } from '../../functions/src/company/format'

describe('formatDateFull / formatDateShort — issue #361', () => {
  // 22:20 UTC on 2026-09-21 is already 2026-09-22 in Europe/Stockholm
  // (UTC+2, summer time) — the exact scenario the #361 bug report names:
  // the mail said "27 September" and the stop page said "28 September" for
  // the same ledger, same timestamp, because one side rendered in UTC (the
  // Cloud Functions runtime's own zone, never chosen on purpose) and the
  // other in the visitor's browser zone.
  const NEAR_MIDNIGHT = Timestamp.fromDate(new Date('2026-09-21T22:20:00.000Z'))

  it('renders the STOCKHOLM calendar date, one day ahead of the UTC one, for an instant just before local midnight', () => {
    expect(formatDateFull(NEAR_MIDNIGHT, 'Europe/Stockholm')).toBe('22 September 2026')
    expect(formatDateFull(NEAR_MIDNIGHT, 'UTC')).toBe('21 September 2026')
  })

  it('formatDateShort renders the same day boundary', () => {
    // 'en-GB' abbreviates September as "Sept" (Intl's own month-short form for
    // this locale/month, not something this function chooses) — assert via
    // the underlying formatter rather than hardcode a guessed abbreviation.
    const shortSept = new Intl.DateTimeFormat('en-GB', { month: 'short' }).format(new Date('2026-09-01'))
    expect(formatDateShort(NEAR_MIDNIGHT, 'Europe/Stockholm')).toBe(`22 ${shortSept}`)
    expect(formatDateShort(NEAR_MIDNIGHT, 'UTC')).toBe(`21 ${shortSept}`)
  })

  it('falls back to UTC for an unrecognised timezone string, rather than throwing', () => {
    const shortSept = new Intl.DateTimeFormat('en-GB', { month: 'short' }).format(new Date('2026-09-01'))
    expect(formatDateFull(NEAR_MIDNIGHT, 'Not/AZone')).toBe('21 September 2026')
    expect(formatDateShort(NEAR_MIDNIGHT, 'Not/AZone')).toBe(`21 ${shortSept}`)
  })

  it('renders an ordinary midday instant identically regardless of zone choice (mutation guard against a no-op timeZone param)', () => {
    const midday = Timestamp.fromDate(new Date('2026-06-15T12:00:00.000Z'))
    expect(formatDateFull(midday, 'Europe/Stockholm')).toBe('15 June 2026')
    expect(formatDateFull(midday, 'America/Los_Angeles')).toBe('15 June 2026')
  })
})

describe('formatRequesterDisplay — issue #334', () => {
  it('renders the fixed support string for an operator-sourced request', () => {
    expect(formatRequesterDisplay('operator', 'jocke@allocate.at')).toBe('Allocate support (support@allocate.at)')
  })

  it('never leaks the operator email into the support string', () => {
    expect(formatRequesterDisplay('operator', 'ops-internal@allocate.at')).not.toContain('ops-internal@allocate.at')
  })

  it('renders requestedByName for an admin-sourced request', () => {
    expect(formatRequesterDisplay('admin', 'Anna Admin')).toBe('Anna Admin')
  })

  it('renders requestedByName for a legacy row with no requestSource', () => {
    expect(formatRequesterDisplay(undefined, 'Anna Admin')).toBe('Anna Admin')
  })

  it('falls back to "An administrator" for a null (redacted) requestedByName — preserves purgeLogs.ts null-redaction behaviour', () => {
    expect(formatRequesterDisplay('admin', null)).toBe('An administrator')
    expect(formatRequesterDisplay(undefined, null)).toBe('An administrator')
  })
})
