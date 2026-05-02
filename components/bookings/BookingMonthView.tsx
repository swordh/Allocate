'use client'

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useBookings } from '@/hooks/useBookings'
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

interface GridDay {
  dateStr: string
  isCurrentMonth: boolean
}

function getMonthGrid(year: number, month: number): GridDay[] {
  const firstDay     = new Date(year, month - 1, 1)
  const lastDay      = new Date(year, month, 0)
  const startPadding = (firstDay.getDay() + 6) % 7  // Mon=0 … Sun=6

  const result: GridDay[] = []

  // Prev month fill
  const prevLastDay = new Date(year, month - 1, 0)
  for (let i = startPadding - 1; i >= 0; i--) {
    const d = new Date(prevLastDay)
    d.setDate(prevLastDay.getDate() - i)
    result.push({ dateStr: toDateString(d), isCurrentMonth: false })
  }

  // Current month
  for (let d = 1; d <= lastDay.getDate(); d++) {
    result.push({ dateStr: toDateString(new Date(year, month - 1, d)), isCurrentMonth: true })
  }

  // Next month fill
  let n = 1
  while (result.length % 7 !== 0) {
    result.push({ dateStr: toDateString(new Date(year, month, n++)), isCurrentMonth: false })
  }

  return result
}

function formatMonthYear(year: number, month: number): string {
  const d = new Date(year, month - 1, 1)
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }).toUpperCase()
}

function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr + 'T00:00:00').getDay()
  return d === 0 || d === 6
}

function statusDotClass(status: string): string {
  switch (status) {
    case 'checked_out': return styles.dotCheckedOut
    case 'confirmed':   return styles.dotConfirmed
    case 'returned':    return styles.dotReturned
    default:            return styles.dotPending
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
        <button className={styles.navBtn} onClick={() => navigate(prevYear, prevMonth)}>←</button>
        <span className={styles.monthLabel}>{formatMonthYear(year, month)}</span>
        <button className={styles.navBtn} onClick={() => navigate(nextYear, nextMonth)}>→</button>
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

      {/* Calendar grid */}
      <div className={styles.grid}>
        {/* Weekday header row */}
        {WEEKDAYS.map((wd, i) => (
          <div key={wd} className={`${styles.dayHeader} ${i >= 5 ? styles.dayHeaderWeekend : ''}`}>
            {wd}
          </div>
        ))}

        {/* Day cells */}
        {grid.map((item, i) => {
          const isToday     = item.dateStr === today
          const weekend     = isWeekend(item.dateStr)
          const dayNum      = new Date(item.dateStr + 'T00:00:00').getDate()
          const dayBookings = item.isCurrentMonth ? bookingsForDay(item.dateStr) : []

          return (
            <div
              key={`${item.dateStr}-${i}`}
              className={[
                styles.day,
                weekend               ? styles.dayWeekend    : '',
                !item.isCurrentMonth  ? styles.dayOutOfMonth : '',
                isToday               ? styles.dayToday      : '',
              ].filter(Boolean).join(' ')}
            >
              <span className={`${styles.dayNum} ${isToday ? styles.dayNumToday : ''}`}>
                {dayNum}
              </span>
              {item.isCurrentMonth && (
                <div className={styles.dayBookings}>
                  {dayBookings.slice(0, 3).map((booking) => (
                    <Link
                      key={booking.id}
                      href={`/bookings/${booking.id}`}
                      className={styles.bookingRow}
                    >
                      <span className={`${styles.bookingDot} ${statusDotClass(booking.status)}`} />
                      <span className={styles.bookingName}>{booking.projectName}</span>
                    </Link>
                  ))}
                  {dayBookings.length > 3 && (
                    <span className={styles.moreBookings}>+{dayBookings.length - 3} more</span>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Empty state */}
      {bookings.filter((b) => b.status !== 'cancelled').length === 0 && (
        <div className={styles.emptyState}>
          <p>No bookings this month.</p>
          <Link href="/bookings/new" className={styles.emptyAction}>New Booking</Link>
        </div>
      )}
    </div>
  )
}
