/**
 * zonedWallClockToInstant (issue #329): company-local "date + HH:MM" → UTC
 * instant, Intl only. The DST cases are the point of this file — they pin the
 * product decisions (a skipped time moves forward, a repeated time uses the
 * first occurrence).
 */
import { describe, expect, it } from 'vitest'
import { zonedWallClockToInstant } from '@/lib/booking-auto-status'

const iso = (date: string, time: string, tz: string) =>
  zonedWallClockToInstant(date, time, tz).toISOString()

describe('zonedWallClockToInstant', () => {
  it('UTC is the identity', () => {
    expect(iso('2026-06-15', '12:00', 'UTC')).toBe('2026-06-15T12:00:00.000Z')
  })

  it('Stockholm on a normal summer and winter day', () => {
    expect(iso('2026-06-15', '12:00', 'Europe/Stockholm')).toBe('2026-06-15T10:00:00.000Z')
    expect(iso('2026-01-15', '12:00', 'Europe/Stockholm')).toBe('2026-01-15T11:00:00.000Z')
  })

  it('Stockholm spring-forward gap: 02:30 does not exist and moves to the first valid instant after', () => {
    expect(iso('2026-03-29', '02:30', 'Europe/Stockholm')).toBe('2026-03-29T01:00:00.000Z')
    // Either side of the gap is untouched.
    expect(iso('2026-03-29', '01:59', 'Europe/Stockholm')).toBe('2026-03-29T00:59:00.000Z')
    expect(iso('2026-03-29', '03:00', 'Europe/Stockholm')).toBe('2026-03-29T01:00:00.000Z')
  })

  it('Stockholm fall-back overlap: 02:30 occurs twice and uses the first occurrence', () => {
    expect(iso('2026-10-25', '02:30', 'Europe/Stockholm')).toBe('2026-10-25T00:30:00.000Z')
  })

  it('New York, including its own gap and overlap', () => {
    expect(iso('2026-07-01', '09:00', 'America/New_York')).toBe('2026-07-01T13:00:00.000Z')
    expect(iso('2026-03-08', '02:30', 'America/New_York')).toBe('2026-03-08T07:00:00.000Z')
    expect(iso('2026-11-01', '01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z')
  })

  it('Kolkata (+05:30, no DST)', () => {
    expect(iso('2026-01-01', '12:00', 'Asia/Kolkata')).toBe('2026-01-01T06:30:00.000Z')
  })

  it('Lord_Howe (30-minute DST shift)', () => {
    expect(iso('2026-07-01', '12:00', 'Australia/Lord_Howe')).toBe('2026-07-01T01:30:00.000Z')
    // 2026-10-04 02:00 → 02:30; 02:15 is in the gap.
    expect(iso('2026-10-04', '02:15', 'Australia/Lord_Howe')).toBe('2026-10-03T15:30:00.000Z')
  })

  it('Kiritimati (+14, the calendar day is ahead of UTC)', () => {
    expect(iso('2026-01-01', '00:00', 'Pacific/Kiritimati')).toBe('2025-12-31T10:00:00.000Z')
    expect(iso('2026-01-01', '23:59', 'Pacific/Kiritimati')).toBe('2026-01-01T09:59:00.000Z')
  })

  it('an unknown time zone falls back to UTC', () => {
    expect(iso('2026-06-15', '12:00', 'Not/AZone')).toBe('2026-06-15T12:00:00.000Z')
  })

  it('throws on a malformed date or time', () => {
    expect(() => zonedWallClockToInstant('2026-6-15', '12:00', 'UTC')).toThrow(RangeError)
    expect(() => zonedWallClockToInstant('2026-06-15', '9:00', 'UTC')).toThrow(RangeError)
  })

  it.each([
    ['2026-13-01', '12:00'],
    ['2026-00-10', '12:00'],
    ['2026-02-30', '12:00'],
    ['2026-04-31', '12:00'],
    ['2026-06-15', '24:00'],
    ['2026-06-15', '12:60'],
  ])('throws on an out-of-range value (%s %s) instead of rolling over', (date, time) => {
    expect(() => zonedWallClockToInstant(date, time, 'UTC')).toThrow(RangeError)
  })

  it('accepts a leap day and the last valid minute', () => {
    expect(iso('2028-02-29', '23:59', 'UTC')).toBe('2028-02-29T23:59:00.000Z')  })
})
