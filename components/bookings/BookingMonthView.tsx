'use client'

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useBookings } from '@/hooks/useBookings'
import BookingStatusBadge from './BookingStatusBadge'
import type { Booking } from '@/types'
import styles from './BookingMonthView.module.css'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function todayString(): string {
  return toDateString(new Date())
}

function getMonthBounds(year: number, month: number): { start: string; end: string } {
  const start = new Date(year, month - 1, 1)
  const end   = new Date(year, month, 0)
  return { start: toDateString(start), end: toDateString(end) }
}

/** Returns an array of 35 or 42 slots (some null = padding days outside month). */
function getMonthGrid(year: number, month: number): (string | null)[] {
  const firstDay     = new Date(year, month - 1, 1)
  const lastDay      = new Date(year, month, 0)
  const startPadding = (firstDay.getDay() + 6) % 7  // Mon=0 … Sun=6

  const days: (string | null)[] = []
  for (let i = 0; i < startPadding; i++) days.push(null)
  for (let d = 1; d <= lastDay.getDate(); d++) {
    days.push(toDateString(new Date(year, month - 1, d)))
  }
  while (days.length % 7 !== 0) days.push(null)
  return days
}

function formatMonthYear(year: number, month: number): string {
  const d = new Date(year, month - 1, 1)
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }).toUpperCase()
}

function statusClass(status: string): string {
  switch (status) {
    case 'checked_out': return styles.blockCheckedOut
    case 'confirmed':   return styles.blockConfirmed
    case 'pending':     return styles.blockPending
    case 'returned':    return styles.blockReturned
    default:            return styles.blockPending
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface BookingMonthViewProps {
  companyId: string
  initialBookings: Booking[]
  year: number
  month: number
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function BookingMonthView({
  companyId,
  initialBookings,
  year,
  month,
}: BookingMonthViewProps) {
  const router = useRouter()
  const { start, end } = getMonthBounds(year, month)

  const { bookings: liveBookings, loading } = useBookings(companyId, {
    startDate: start,
    endDate:   end,
  })

  const bookings = loading ? initialBookings : liveBookings
  const today    = todayString()
  const grid     = useMemo(() => getMonthGrid(year, month), [year, month])

  function bookingsForDay(dayStr: string): Booking[] {
    return bookings.filter(
      (b) => b.startDate <= dayStr && b.endDate >= dayStr && b.status !== 'cancelled',
    )
  }

  // Navigation
  const prevYear  = month === 1 ? year - 1 : year
  const prevMonth = month === 1 ? 12 : month - 1
  const nextYear  = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1

  function navigate(y: number, m: number) {
    router.push(`/bookings/month?year=${y}&month=${m}`)
  }

  const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

  return (
    <div className={styles.container}>
      {/* Nav bar */}
      <div className={styles.navBar}>
        <button
          className={styles.navBtn}
          onClick={() => navigate(prevYear, prevMonth)}
        >
          ←
        </button>
        <span className={styles.monthLabel}>{formatMonthYear(year, month)}</span>
        <button
          className={styles.navBtn}
          onClick={() => navigate(nextYear, nextMonth)}
        >
          →
        </button>
        <button
          className={styles.todayBtn}
          onClick={() => {
            const now = new Date()
            navigate(now.getFullYear(), now.getMonth() + 1)
          }}
        >
          Today
        </button>
      </div>

      {/* Weekday header row */}
      <div className={styles.grid}>
        {WEEKDAYS.map((wd) => (
          <div key={wd} className={styles.dayHeader}>{wd}</div>
        ))}

        {/* Day cells */}
        {grid.map((dayStr, i) => {
          if (!dayStr) {
            return <div key={`pad-${i}`} className={styles.dayEmpty} />
          }

          const isToday     = dayStr === today
          const dayBookings = bookingsForDay(dayStr)
          const dayNum      = new Date(dayStr + 'T00:00:00').getDate()

          return (
            <div
              key={dayStr}
              className={`${styles.day} ${isToday ? styles.dayToday : ''}`}
            >
              <span className={`${styles.dayNum} ${isToday ? styles.dayNumToday : ''}`}>
                {dayNum}
              </span>
              <div className={styles.dayBookings}>
                {dayBookings.slice(0, 3).map((booking) => (
                  <Link
                    key={booking.id}
                    href={`/bookings/${booking.id}`}
                    className={`${styles.block} ${statusClass(booking.status)}`}
                  >
                    {booking.projectName}
                  </Link>
                ))}
                {dayBookings.length > 3 && (
                  <span className={styles.moreBookings}>+{dayBookings.length - 3} more</span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Empty state */}
      {bookings.filter((b) => b.status !== 'cancelled').length === 0 && (
        <div className={styles.emptyState}>
          <p>No bookings this month.</p>
          <Link href="/bookings/new" className={styles.emptyAction}>
            New Booking
          </Link>
        </div>
      )}
    </div>
  )
}
