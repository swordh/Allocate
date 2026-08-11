import { describe, it, expect } from 'vitest'
import { positionBookings, packIntoLanes, bookingsForDay } from '@/lib/bookings/status'
import { getISOWeek, getISOWeekYear, getWeekBounds, getMondayString, offsetDate, todayInTimezone } from '@/lib/dates'
import type { Booking } from '@/types'

function booking(id: string, startDate: string, endDate: string): Booking {
  return {
    id,
    projectName: id,
    notes: '',
    items: [],
    equipmentIds: [],
    unitIds: [],
    startDate,
    endDate,
    startTime: null,
    endTime: null,
    userId: 'u1',
    userName: null,
    status: 'confirmed',
    createdAt: '',
    requiresApproval: false,
    approverId: null,
    approvalStatus: 'none',
    rejectionReason: null,
    cancelledAt: null,
    cancelledBy: null,
  }
}

// Mon 8 Jun 2026 – Sun 14 Jun 2026, the week the design draws.
const WEEK_START = '2026-06-08'
const WEEK_END = '2026-06-14'

describe('positionBookings', () => {
  it('places a single-day booking in one column', () => {
    const [b] = positionBookings([booking('a', '2026-06-10', '2026-06-10')], WEEK_START, WEEK_END)
    expect(b.colStart).toBe(2) // Monday is 0
    expect(b.colSpan).toBe(1)
    expect(b.clipLeft).toBe(false)
    expect(b.clipRight).toBe(false)
  })

  it('treats both ends as inclusive', () => {
    const [b] = positionBookings([booking('a', '2026-06-12', '2026-06-14')], WEEK_START, WEEK_END)
    expect(b.colStart).toBe(4)
    expect(b.colSpan).toBe(3)
  })

  it('clips a booking that started before the week and marks the left edge', () => {
    const [b] = positionBookings([booking('a', '2026-06-04', '2026-06-09')], WEEK_START, WEEK_END)
    expect(b.colStart).toBe(0)
    expect(b.colSpan).toBe(2)
    expect(b.clipLeft).toBe(true)
    expect(b.clipRight).toBe(false)
  })

  it('clips a booking that runs past the week and marks the right edge', () => {
    const [b] = positionBookings([booking('a', '2026-06-14', '2026-06-18')], WEEK_START, WEEK_END)
    expect(b.colStart).toBe(6)
    expect(b.colSpan).toBe(1)
    expect(b.clipRight).toBe(true)
  })

  it('spans the whole week when it swallows it, clipped both sides', () => {
    const [b] = positionBookings([booking('a', '2026-06-06', '2026-06-16')], WEEK_START, WEEK_END)
    expect(b.colStart).toBe(0)
    expect(b.colSpan).toBe(7)
    expect(b.clipLeft).toBe(true)
    expect(b.clipRight).toBe(true)
  })

  it('drops bookings that do not touch the week', () => {
    expect(positionBookings([booking('a', '2026-06-01', '2026-06-07')], WEEK_START, WEEK_END)).toHaveLength(0)
    expect(positionBookings([booking('b', '2026-06-15', '2026-06-20')], WEEK_START, WEEK_END)).toHaveLength(0)
  })

  it('appears in every week row a multi-week booking touches', () => {
    // 4–24 Jun spans three ISO weeks; the month grid positions it per row.
    const long = booking('long', '2026-06-04', '2026-06-24')
    const rows = ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22'].map((rowStart) =>
      positionBookings([long], rowStart, offsetDate(rowStart, 6)),
    )
    expect(rows.map((r) => r.length)).toEqual([1, 1, 1, 1])
    expect(rows[0][0]).toMatchObject({ colStart: 3, colSpan: 4, clipLeft: false, clipRight: true })
    expect(rows[1][0]).toMatchObject({ colStart: 0, colSpan: 7, clipLeft: true, clipRight: true })
    expect(rows[3][0]).toMatchObject({ colStart: 0, colSpan: 3, clipLeft: true, clipRight: false })
  })

  it('keeps a booking whose dates straddle midnight on the last day', () => {
    // endDate is a civil date, so a booking ending on the final day of the
    // window must still be included — this is the month-view bug the design's
    // operator notes flagged.
    const [b] = positionBookings([booking('a', '2026-06-14', '2026-06-14')], WEEK_START, WEEK_END)
    expect(b.colStart).toBe(6)
    expect(b.colSpan).toBe(1)
  })
})

describe('packIntoLanes', () => {
  it('puts non-overlapping bookings in the same lane', () => {
    const packed = packIntoLanes([
      { colStart: 0, colSpan: 2 },
      { colStart: 3, colSpan: 2 },
    ])
    expect(packed.map((p) => p.lane)).toEqual([0, 0])
  })

  it('pushes an overlapping booking into the next lane', () => {
    const packed = packIntoLanes([
      { colStart: 0, colSpan: 4 },
      { colStart: 2, colSpan: 3 },
    ])
    expect(packed.map((p) => p.lane)).toEqual([0, 1])
  })

  it('reuses a freed lane further along the row', () => {
    const packed = packIntoLanes([
      { colStart: 0, colSpan: 2 },
      { colStart: 0, colSpan: 5 },
      { colStart: 3, colSpan: 1 },
    ])
    // Widest first at the same column, then the short one drops back to lane 1.
    expect(packed.find((p) => p.colSpan === 1)?.lane).toBe(1)
  })

  it('treats adjacency as non-overlapping', () => {
    const packed = packIntoLanes([
      { colStart: 0, colSpan: 3 },
      { colStart: 3, colSpan: 1 },
    ])
    expect(packed.map((p) => p.lane)).toEqual([0, 0])
  })
})

describe('bookingsForDay', () => {
  it('includes a booking on its first and last day', () => {
    const list = [booking('a', '2026-06-10', '2026-06-12')]
    expect(bookingsForDay(list, '2026-06-10')).toHaveLength(1)
    expect(bookingsForDay(list, '2026-06-11')).toHaveLength(1)
    expect(bookingsForDay(list, '2026-06-12')).toHaveLength(1)
    expect(bookingsForDay(list, '2026-06-13')).toHaveLength(0)
  })

  it('leaves cancelled bookings in — the SHOW CANCELLED filter owns that', () => {
    const cancelled = { ...booking('a', '2026-06-10', '2026-06-10'), status: 'cancelled' as const }
    expect(bookingsForDay([cancelled], '2026-06-10')).toHaveLength(1)
  })
})

describe('ISO weeks and timezone', () => {
  it('round-trips a date through week number and bounds', () => {
    expect(getISOWeek('2026-06-10')).toBe(24)
    expect(getISOWeekYear('2026-06-10')).toBe(2026)
    expect(getWeekBounds(2026, 24)).toEqual({ weekStart: '2026-06-08', weekEnd: '2026-06-14' })
  })

  it('keeps a year-boundary week in the week-year that owns it', () => {
    // 1 Jan 2027 is a Friday, so it belongs to ISO week 53 of 2026.
    expect(getISOWeek('2027-01-01')).toBe(53)
    expect(getISOWeekYear('2027-01-01')).toBe(2026)
    expect(getWeekBounds(2026, 53).weekStart).toBe('2026-12-28')
  })

  it('snaps any day to its Monday', () => {
    expect(getMondayString('2026-06-14')).toBe('2026-06-08') // Sunday
    expect(getMondayString('2026-06-08')).toBe('2026-06-08') // Monday
  })

  it('does not shift a civil date when stepping across a DST boundary', () => {
    // Europe/Stockholm springs forward on 29 Mar 2026.
    expect(offsetDate('2026-03-28', 1)).toBe('2026-03-29')
    expect(offsetDate('2026-03-29', 1)).toBe('2026-03-30')
  })

  it('reads today in the company zone, not the runtime one', () => {
    const utc = todayInTimezone('UTC')
    expect(utc).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // Auckland is at least half a day ahead of Honolulu, so the two can never
    // both be wrong in the same direction — one of them differs from the other
    // for most of the day, and neither may throw.
    expect(todayInTimezone('Pacific/Auckland')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(todayInTimezone('Pacific/Honolulu')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('falls back to UTC rather than throwing on an unknown zone', () => {
    expect(todayInTimezone('Not/AZone')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
