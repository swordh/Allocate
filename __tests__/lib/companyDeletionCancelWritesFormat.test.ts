/**
 * `formatDateFull` in lib/companyDeletionCancelWrites.ts — issue #361. This
 * is the App-Hosting-side duplicate of functions/src/company/format.ts's
 * `formatDateFull` (see that file's own test,
 * __tests__/company/companyDeletionFormat.test.ts, for the twin coverage) —
 * deliberately duplicated because functions/ compiles as its own project.
 */
import { describe, it, expect } from 'vitest'
import { formatDateFull } from '@/lib/companyDeletionCancelWrites'

describe('formatDateFull (lib/companyDeletionCancelWrites.ts) — issue #361', () => {
  // Same instant as the functions-side test: 22:20 UTC on 2026-09-21 is
  // already 2026-09-22 in Europe/Stockholm (UTC+2, summer time).
  const NEAR_MIDNIGHT_ISO = '2026-09-21T22:20:00.000Z'

  it('renders the STOCKHOLM calendar date, one day ahead of the UTC one', () => {
    expect(formatDateFull(NEAR_MIDNIGHT_ISO, 'Europe/Stockholm')).toBe('22 September 2026')
    expect(formatDateFull(NEAR_MIDNIGHT_ISO, 'UTC')).toBe('21 September 2026')
  })

  it('falls back to UTC for an unrecognised timezone string', () => {
    expect(formatDateFull(NEAR_MIDNIGHT_ISO, 'Not/AZone')).toBe('21 September 2026')
  })

  it('returns the raw input for an unparseable ISO string, same as before this fix', () => {
    expect(formatDateFull('not-a-date', 'Europe/Stockholm')).toBe('not-a-date')
  })
})
