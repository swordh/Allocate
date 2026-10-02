/**
 * Guards `lib/booking-auto-status.ts` against drifting from
 * `functions/src/bookings/autoStatusLogic.ts` (issue #329). The two are meant
 * to be identical; App Hosting cannot import `functions/src`, so this is the
 * only thing standing between the copies and silent drift — same pattern as
 * `__tests__/mail/mailRetentionParity.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import * as appCopy from '@/lib/booking-auto-status'
import * as functionsCopy from '../../functions/src/bookings/autoStatusLogic'

const ZONES = ['UTC', 'Europe/Stockholm', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe', 'Pacific/Kiritimati', 'Not/AZone']
const DATES = ['2026-01-15', '2026-03-29', '2026-03-08', '2026-10-25', '2026-10-04', '2026-11-01']
const TIMES = ['00:00', '02:15', '02:30', '12:00', '23:59']

describe('booking-auto-status parity (app vs functions)', () => {
  it('exports the same names', () => {
    expect(Object.keys(appCopy).sort()).toEqual(Object.keys(functionsCopy).sort())
  })

  it('MAX_SCHEDULE_AHEAD_MS is identical', () => {
    expect(appCopy.MAX_SCHEDULE_AHEAD_MS).toBe(functionsCopy.MAX_SCHEDULE_AHEAD_MS)
  })

  it('zonedWallClockToInstant agrees across zones, DST edges and times', () => {
    for (const tz of ZONES) for (const d of DATES) for (const t of TIMES) {
      expect(appCopy.zonedWallClockToInstant(d, t, tz).getTime()).toBe(functionsCopy.zonedWallClockToInstant(d, t, tz).getTime())
    }
  })

  it('computeDueInstant agrees, timed and all-day', () => {
    for (const tz of ZONES) for (const transition of ['checkout', 'checkin'] as const) {
      for (const b of [
        { startDate: '2026-03-29', startTime: '02:30', endDate: '2026-10-25', endTime: '02:30' },
        { startDate: '2026-06-15', startTime: null, endDate: '2026-06-16', endTime: null },
        { startDate: 'bad', endDate: undefined },
      ]) {
        expect(appCopy.computeDueInstant(b, transition, tz)).toBe(functionsCopy.computeDueInstant(b, transition, tz))
      }
    }
  })

  it('readAutoPrefs, transitionFor, planBookingEnqueue, planCompanyEnqueue, decideTask, scheduleTimeFor, taskId agree', () => {
    const data = { preferences: { autoCheckout: true, autoCheckin: true, timezone: 'Europe/Stockholm', autoCheckoutSince: { toMillis: () => 1000 } } }
    const prefs = appCopy.readAutoPrefs(data)
    expect(prefs).toEqual(functionsCopy.readAutoPrefs(data))
    const off = { ...prefs, autoCheckout: false, autoCheckin: false }

    for (const s of ['confirmed', 'checked_out', 'returned', 'cancelled', 'pending', undefined]) {
      expect(appCopy.transitionFor(s)).toBe(functionsCopy.transitionFor(s))
    }

    const b = { status: 'confirmed', startDate: '2026-06-15', startTime: '09:00', endDate: '2026-06-16', endTime: '17:00' }
    const variants = [
      undefined, b, { ...b, status: 'checked_out' }, { ...b, startTime: '10:00' }, { ...b, endTime: '18:00' }, { ...b, status: 'cancelled' },
      { ...b, createdAt: { toMillis: () => 5000 } }, { ...b, updatedAt: { toMillis: () => 10 ** 13 } },
    ]
    for (const before of variants) for (const after of variants) for (const p of [prefs, off]) {
      expect(appCopy.planBookingEnqueue(before, after, p)).toEqual(functionsCopy.planBookingEnqueue(before, after, p))
    }
    for (const t of ['checkout', 'checkin'] as const) for (const before of variants) for (const after of variants) {
      if (after) expect(appCopy.watchedFieldsChanged(before, after, t)).toBe(functionsCopy.watchedFieldsChanged(before, after, t))
    }
    expect(appCopy.planCompanyEnqueue(off, prefs)).toEqual(functionsCopy.planCompanyEnqueue(off, prefs))
    expect(appCopy.planCompanyEnqueue(prefs, { ...prefs, tz: 'UTC' })).toEqual(functionsCopy.planCompanyEnqueue(prefs, { ...prefs, tz: 'UTC' }))

    const now = Date.parse('2026-06-15T08:00:00Z')
    for (const transition of ['checkout', 'checkin'] as const) for (const dueAt of [now - 1, Date.parse('2026-06-15T07:00:00Z'), now + 1]) {
      const payload = { companyId: 'c', bookingId: 'b', transition, dueAt }
      for (const bk of variants) for (const nowT of [now, Date.parse('2026-06-01T00:00:00Z')]) for (const p of [prefs, off]) {
        expect(appCopy.decideTask(payload, bk, p, nowT)).toEqual(functionsCopy.decideTask(payload, bk, p, nowT))
      }
    }

    for (const due of [now - 5, now + 5, now + 90 * 24 * 3600_000]) {
      expect(appCopy.scheduleTimeFor(due, now)).toBe(functionsCopy.scheduleTimeFor(due, now))
    }
    expect(appCopy.taskId('checkin', ['a', 'b', 3])).toBe(functionsCopy.taskId('checkin', ['a', 'b', 3]))
  })
})
