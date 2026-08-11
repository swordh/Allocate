'use client'

import { useMemo } from 'react'
import { useBookings } from './useBookings'
import type { BookingStatus } from '@/types'

export interface UnitBookingRef {
  id: string
  projectName: string
  status: BookingStatus
  startDate: string
  endDate: string
  /** "Jul 29, 18:00" — end date plus end time when the booking isn't all-day. */
  dueLabel: string
  /** "Aug 3 – Aug 6", collapsed to a single date when start and end match. */
  rangeLabel: string
}

export interface UnitBookingState {
  /** The booking this unit is physically out on, if any. */
  out: UnitBookingRef | null
  /** Bookings that have not started yet, soonest first. */
  upcoming: UnitBookingRef[]
}

const UPCOMING_STATUSES: BookingStatus[] = ['pending', 'confirmed']

function formatDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`)
  if (Number.isNaN(d.getTime())) return isoDate
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatRange(startDate: string, endDate: string): string {
  const start = formatDay(startDate)
  if (startDate === endDate) return start
  return `${start} – ${formatDay(endDate)}`
}

function formatDue(endDate: string, endTime?: string | null): string {
  const day = formatDay(endDate)
  return endTime ? `${day}, ${endTime}` : day
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Maps every unit in the company to what it is currently out on and what is
 * booked for it next.
 *
 * One listener for the whole company, grouped in memory — the alternative, a
 * `unitIds array-contains` query per unit, would be one round trip per chip on
 * the equipment page. `useBookings` already bounds the query server-side on
 * endDate, so no new index is involved.
 */
export function useUnitBookings(companyId: string) {
  const { bookings, loading, error } = useBookings(companyId)

  /**
   * equipmentId → quantity currently on booking. Quantity-tracked equipment has
   * no units to key on, so the equipment row shows this instead.
   */
  const quantityOnBooking = useMemo(() => {
    const today = todayString()
    const map = new Map<string, number>()

    for (const booking of bookings) {
      if (booking.status !== 'checked_out' && booking.status !== 'confirmed') continue
      if (booking.startDate > today || booking.endDate < today) continue

      for (const item of booking.items ?? []) {
        if (item.unitId) continue // unit-tracked items are counted per unit
        map.set(item.equipmentId, (map.get(item.equipmentId) ?? 0) + (item.quantity ?? 0))
      }
    }

    return map
  }, [bookings])

  const unitBookings = useMemo(() => {
    const today = todayString()
    const map = new Map<string, UnitBookingState>()

    // Ascending by start date so `upcoming` comes out soonest-first for free.
    const sorted = [...bookings].sort((a, b) => a.startDate.localeCompare(b.startDate))

    for (const booking of sorted) {
      const unitIds = booking.unitIds ?? []
      if (unitIds.length === 0) continue

      const isOut = booking.status === 'checked_out'
      const isUpcoming = UPCOMING_STATUSES.includes(booking.status) && booking.startDate > today
      if (!isOut && !isUpcoming) continue

      const ref: UnitBookingRef = {
        id: booking.id,
        projectName: booking.projectName,
        status: booking.status,
        startDate: booking.startDate,
        endDate: booking.endDate,
        dueLabel: formatDue(booking.endDate, booking.endTime),
        rangeLabel: formatRange(booking.startDate, booking.endDate),
      }

      for (const unitId of unitIds) {
        let state = map.get(unitId)
        if (!state) {
          state = { out: null, upcoming: [] }
          map.set(unitId, state)
        }

        // A unit can only be physically out on one booking; if the data ever says
        // otherwise, the one due back first wins.
        if (isOut) {
          if (!state.out || ref.endDate < state.out.endDate) state.out = ref
        } else {
          state.upcoming.push(ref)
        }
      }
    }

    return map
  }, [bookings])

  return { unitBookings, quantityOnBooking, loading, error }
}
