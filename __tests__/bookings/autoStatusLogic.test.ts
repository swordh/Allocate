/**
 * Pure decision logic for automatic check-out / check-in (issue #329).
 * The task handler's guards (flag, status, since) are decided HERE — these
 * tests are what stops one of them being silently dropped.
 */
import { describe, expect, it } from 'vitest'
import {
  computeDueInstant,
  decideTask,
  MAX_SCHEDULE_AHEAD_MS,
  planBookingEnqueue,
  planCompanyEnqueue,
  readAutoPrefs,
  scheduleTimeFor,
  taskId,
  transitionFor,
  type AutoPrefs,
  type AutoTaskPayload,
} from '@/lib/booking-auto-status'

const T = (iso: string) => Date.parse(iso)

const prefs = (over: Partial<AutoPrefs> = {}): AutoPrefs => ({
  autoCheckout: true,
  autoCheckin: true,
  autoCheckoutSince: null,
  autoCheckinSince: null,
  tz: 'Europe/Stockholm',
  ...over,
})

const booking = {
  status: 'confirmed',
  startDate: '2026-06-15',
  startTime: '09:00',
  endDate: '2026-06-16',
  endTime: '17:00',
}

describe('readAutoPrefs', () => {
  it('counts a flag only when it is exactly true', () => {
    const p = readAutoPrefs({ preferences: { autoCheckout: 'true', autoCheckin: 1 } })
    expect(p.autoCheckout).toBe(false)
    expect(p.autoCheckin).toBe(false)
    expect(readAutoPrefs({ preferences: { autoCheckout: true } }).autoCheckout).toBe(true)
  })

  it('defaults the zone to UTC and reads since from a Timestamp-like or number', () => {
    expect(readAutoPrefs(undefined).tz).toBe('UTC')
    const p = readAutoPrefs({
      preferences: { timezone: 'Asia/Kolkata', autoCheckoutSince: { toMillis: () => 5 }, autoCheckinSince: 7 },
    })
    expect(p.tz).toBe('Asia/Kolkata')
    expect(p.autoCheckoutSince).toBe(5)
    expect(p.autoCheckinSince).toBe(7)
    expect(readAutoPrefs({ preferences: {} }).autoCheckoutSince).toBeNull()
  })
})

describe('computeDueInstant', () => {
  it('timed booking: check-out at startTime, check-in at endTime, company-local', () => {
    expect(computeDueInstant(booking, 'checkout', 'Europe/Stockholm')).toBe(T('2026-06-15T07:00:00Z'))
    expect(computeDueInstant(booking, 'checkin', 'Europe/Stockholm')).toBe(T('2026-06-16T15:00:00Z'))
  })

  it('all-day booking: check-out 00:00 on startDate, check-in 23:59 on endDate', () => {
    const allDay = { ...booking, startTime: null, endTime: null }
    expect(computeDueInstant(allDay, 'checkout', 'UTC')).toBe(T('2026-06-15T00:00:00Z'))
    expect(computeDueInstant(allDay, 'checkin', 'UTC')).toBe(T('2026-06-16T23:59:00Z'))
    // The old job returned at 00:00 on endDate; this must be the END of that day.
    expect(computeDueInstant(allDay, 'checkin', 'UTC')).toBeGreaterThan(T('2026-06-16T00:00:00Z'))
  })

  it('returns null for missing or malformed dates', () => {
    expect(computeDueInstant({ ...booking, startDate: undefined }, 'checkout', 'UTC')).toBeNull()
    expect(computeDueInstant({ ...booking, startDate: 'nope' }, 'checkout', 'UTC')).toBeNull()
  })
})

describe('transitionFor', () => {
  it('maps confirmed → checkout and checked_out → checkin, nothing else', () => {
    expect(transitionFor('confirmed')).toBe('checkout')
    expect(transitionFor('checked_out')).toBe('checkin')
    for (const s of ['pending', 'returned', 'cancelled', undefined, null]) expect(transitionFor(s)).toBeNull()
  })
})

describe('planBookingEnqueue', () => {
  it('plans a check-out for a newly created confirmed booking', () => {
    expect(planBookingEnqueue(undefined, booking, prefs())).toEqual({
      transition: 'checkout',
      dueAt: T('2026-06-15T07:00:00Z'),
    })
  })

  it('plans a check-in when the booking becomes checked_out', () => {
    expect(planBookingEnqueue(booking, { ...booking, status: 'checked_out' }, prefs())).toEqual({
      transition: 'checkin',
      dueAt: T('2026-06-16T15:00:00Z'),
    })
  })

  it('does nothing when no relevant field changed', () => {
    expect(planBookingEnqueue(booking, { ...booking }, prefs())).toBeNull()
  })

  it.each(['startDate', 'startTime', 'endDate', 'endTime'] as const)('re-plans when %s changed', (field) => {
    const after = { ...booking, [field]: field.endsWith('Date') ? '2026-06-20' : '10:00' }
    expect(planBookingEnqueue(booking, after, prefs())).not.toBeNull()
  })

  it('does nothing for statuses without a transition, deletes, or when the flag is off', () => {
    expect(planBookingEnqueue(booking, { ...booking, status: 'cancelled' }, prefs())).toBeNull()
    expect(planBookingEnqueue(booking, undefined, prefs())).toBeNull()
    expect(planBookingEnqueue(undefined, booking, prefs({ autoCheckout: false }))).toBeNull()
    // The check-out flag does not enable check-in planning.
    expect(
      planBookingEnqueue(booking, { ...booking, status: 'checked_out' }, prefs({ autoCheckin: false })),
    ).toBeNull()
  })

  it('forward-only: skips a booking whose due time is before the flag since', () => {
    const since = T('2026-06-15T07:00:01Z')
    expect(planBookingEnqueue(undefined, booking, prefs({ autoCheckoutSince: since }))).toBeNull()
    expect(planBookingEnqueue(undefined, booking, prefs({ autoCheckoutSince: T('2026-06-15T07:00:00Z') }))).not.toBeNull()
  })
})

describe('planCompanyEnqueue', () => {
  const off = prefs({ autoCheckout: false, autoCheckin: false })

  it('triggers on a flag going false → true, per flag', () => {
    expect(planCompanyEnqueue(off, prefs({ autoCheckin: false }))).toEqual(['checkout'])
    expect(planCompanyEnqueue(off, prefs({ autoCheckout: false }))).toEqual(['checkin'])
    expect(planCompanyEnqueue(off, prefs())).toEqual(['checkout', 'checkin'])
  })

  it('triggers on a time zone change only for flags that are on', () => {
    expect(planCompanyEnqueue(prefs(), prefs({ tz: 'UTC' }))).toEqual(['checkout', 'checkin'])
    expect(planCompanyEnqueue(prefs({ autoCheckin: false }), prefs({ autoCheckin: false, tz: 'UTC' }))).toEqual(['checkout'])
    expect(planCompanyEnqueue(off, { ...off, tz: 'UTC' })).toEqual([])
  })

  it('does nothing when nothing relevant changed or a flag goes off', () => {
    expect(planCompanyEnqueue(prefs(), prefs())).toEqual([])
    expect(planCompanyEnqueue(prefs(), off)).toEqual([])
  })
})

describe('decideTask', () => {
  const now = T('2026-06-15T08:00:00Z')
  const payload = (over: Partial<AutoTaskPayload> = {}): AutoTaskPayload => ({
    companyId: 'c1',
    bookingId: 'b1',
    transition: 'checkout',
    dueAt: T('2026-06-15T07:00:00Z'),
    ...over,
  })

  it('apply when due has passed', () => {
    expect(decideTask(payload(), booking, prefs(), now)).toEqual({ kind: 'apply' })
    // Exactly due counts as due.
    expect(decideTask(payload(), booking, prefs(), T('2026-06-15T07:00:00Z'))).toEqual({ kind: 'apply' })
  })

  it('skip when the booking is gone or in the wrong status', () => {
    expect(decideTask(payload(), undefined, prefs(), now)).toEqual({ kind: 'skip', reason: 'missing' })
    expect(decideTask(payload(), { ...booking, status: 'cancelled' }, prefs(), now)).toEqual({ kind: 'skip', reason: 'status' })
    expect(decideTask(payload(), { ...booking, status: 'checked_out' }, prefs(), now)).toEqual({ kind: 'skip', reason: 'status' })
    expect(decideTask(payload({ transition: 'checkin' }), booking, prefs(), now)).toEqual({ kind: 'skip', reason: 'status' })
  })

  it('skip when the matching flag is off', () => {
    expect(decideTask(payload(), booking, prefs({ autoCheckout: false }), now)).toEqual({ kind: 'skip', reason: 'flag-off' })
    expect(
      decideTask(payload({ transition: 'checkin' }), { ...booking, status: 'checked_out' }, prefs({ autoCheckin: false }), now),
    ).toEqual({ kind: 'skip', reason: 'flag-off' })
  })

  it('skip when due is before since (forward-only), even though it is overdue', () => {
    expect(decideTask(payload(), booking, prefs({ autoCheckoutSince: now }), now)).toEqual({ kind: 'skip', reason: 'before-since' })
  })

  it('a missing since with the flag on means no restriction (legacy)', () => {
    expect(decideTask(payload(), booking, prefs({ autoCheckoutSince: null }), now)).toEqual({ kind: 'apply' })
  })

  it('hop when not due yet and the payload still matches', () => {
    const early = T('2026-06-01T00:00:00Z')
    expect(decideTask(payload(), booking, prefs(), early)).toEqual({ kind: 'hop' })
  })

  it('stale when not due yet and the payload dueAt no longer matches', () => {
    const early = T('2026-06-01T00:00:00Z')
    expect(decideTask(payload({ dueAt: T('2026-06-14T07:00:00Z') }), booking, prefs(), early)).toEqual({ kind: 'stale' })
  })

  it('a time zone change moves due, so an old payload goes stale', () => {
    const early = T('2026-06-01T00:00:00Z')
    expect(decideTask(payload(), booking, prefs({ tz: 'UTC' }), early)).toEqual({ kind: 'stale' })
  })

  it('check-in uses the end time', () => {
    const p = payload({ transition: 'checkin', dueAt: T('2026-06-16T15:00:00Z') })
    const co = { ...booking, status: 'checked_out' }
    expect(decideTask(p, co, prefs(), T('2026-06-16T15:00:00Z'))).toEqual({ kind: 'apply' })
    expect(decideTask(p, co, prefs(), T('2026-06-16T14:59:00Z'))).toEqual({ kind: 'hop' })
  })
})

describe('scheduleTimeFor', () => {
  const now = T('2026-06-01T00:00:00Z')

  it('is undefined when already due', () => {
    expect(scheduleTimeFor(now, now)).toBeUndefined()
    expect(scheduleTimeFor(now - 1, now)).toBeUndefined()
  })

  it('is the due time when within 29 days', () => {
    expect(scheduleTimeFor(now + 1000, now)).toBe(now + 1000)
  })

  it('caps at now + 29 days', () => {
    expect(scheduleTimeFor(now + 60 * 24 * 3600_000, now)).toBe(now + MAX_SCHEDULE_AHEAD_MS)
    expect(MAX_SCHEDULE_AHEAD_MS).toBe(29 * 24 * 3600_000)
  })
})

describe('taskId', () => {
  it('is deterministic, prefixed with the transition, and Cloud-Tasks-safe', () => {
    const id = taskId('checkout', ['c1', 'b1', 5])
    expect(id).toBe(taskId('checkout', ['c1', 'b1', 5]))
    expect(id).toMatch(/^checkout-[0-9a-f]{48}$/)
    expect(taskId('checkin', ['c1', 'b1', 5])).not.toBe(id)
    expect(taskId('checkout', ['c1', 'b1', 6])).not.toBe(id)
  })
})
