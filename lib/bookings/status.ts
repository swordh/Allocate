/**
 * One booking-status table for the whole app.
 *
 * Before phase 4 the status → label → colour mapping lived in four places
 * (BookingStatusBadge, BookingList's STATUS_LABELS/getStatusRowClass, and a
 * statusDotClass copy in each calendar view), and they had already drifted.
 * Everything reads this instead.
 *
 * The colours come from `statusPalette` in the design files 06/07/08 and are
 * identical across week, month and list by construction — the CSS variables
 * are defined once in app/globals.css.
 *
 * Note that CHECKED OUT and PENDING deliberately share the same amber. That is
 * the design's default palette, confirmed 2026-08-11; it is not a copy/paste
 * slip, so do not "fix" it here.
 */

import type { Booking, BookingStatus } from '@/types'

export interface BookingStatusMeta {
  /** Uppercase label as drawn in the design. */
  label: string
  /** CSS custom property holding this status' colour. */
  colorVar: string
  /** Returned bookings are drawn faded with a dimmed title. */
  muted: boolean
}

export const BOOKING_STATUS: Record<BookingStatus, BookingStatusMeta> = {
  pending:     { label: 'PENDING',     colorVar: 'var(--booking-pending)',     muted: false },
  confirmed:   { label: 'CONFIRMED',   colorVar: 'var(--booking-confirmed)',   muted: false },
  checked_out: { label: 'CHECKED OUT', colorVar: 'var(--booking-checked-out)', muted: false },
  returned:    { label: 'RETURNED',    colorVar: 'var(--booking-returned)',    muted: true  },
  cancelled:   { label: 'CANCELLED',   colorVar: 'var(--booking-cancelled)',   muted: true  },
}

export function statusMeta(status: BookingStatus): BookingStatusMeta {
  return BOOKING_STATUS[status] ?? BOOKING_STATUS.confirmed
}

export function statusLabel(status: BookingStatus): string {
  return statusMeta(status).label
}

export function statusColor(status: BookingStatus): string {
  return statusMeta(status).colorVar
}

/**
 * Bookings covering a civil date. `startDate`/`endDate` are inclusive in both
 * ends, so a plain string comparison is both correct and cheap.
 *
 * Cancelled bookings are *not* filtered here — the SHOW CANCELLED toggle owns
 * that decision, and the calendar views used to hardcode the exclusion.
 */
export function bookingsForDay(bookings: Booking[], day: string): Booking[] {
  return bookings.filter((b) => b.startDate <= day && b.endDate >= day)
}

/** Bookings overlapping a closed date range, in ascending start order. */
export function bookingsInRange(bookings: Booking[], start: string, end: string): Booking[] {
  return bookings
    .filter((b) => b.startDate <= end && b.endDate >= start)
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.projectName.localeCompare(b.projectName))
}

/** Total item count on a booking — the "12 items" meta on every card. */
export function itemCount(booking: Booking): number {
  return (booking.items ?? []).reduce((sum, i) => sum + (i.quantity ?? 0), 0)
}

/**
 * Greedy lane packing, the same algorithm the design's month view uses.
 *
 * Each entry gets the first lane whose last occupied column is free, so
 * non-overlapping bars share a row instead of each claiming their own. Input
 * must be sorted by column, widest first, for the packing to look stable.
 */
export function packIntoLanes<T extends { colStart: number; colSpan: number }>(items: T[]): (T & { lane: number })[] {
  const sorted = [...items].sort((a, b) => a.colStart - b.colStart || b.colSpan - a.colSpan)
  const laneEnds: number[] = []

  return sorted.map((item) => {
    let lane = laneEnds.findIndex((end) => end <= item.colStart)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(0)
    }
    laneEnds[lane] = item.colStart + item.colSpan
    return { ...item, lane }
  })
}
