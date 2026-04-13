'use client'

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useBookings } from '@/hooks/useBookings'
import type { Booking } from '@/types'
import styles from './Booking4WeekView.module.css'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function todayString(): string {
  return toDateString(new Date())
}

/** Returns the Monday of the ISO week containing the given date. */
function getMondayOf(dateStr: string): Date {
  const d = new Date(dateStr + 'T00:00:00')
  const day = (d.getDay() + 6) % 7  // Mon=0 … Sun=6
  d.setDate(d.getDate() - day)
  return d
}

/** Returns 28 consecutive date strings starting from a Monday. */
function get28Days(startMonday: string): string[] {
  const days: string[] = []
  const start = new Date(startMonday + 'T00:00:00')
  for (let i = 0; i < 28; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    days.push(toDateString(d))
  }
  return days
}

function formatDayHeader(dateStr: string): { weekday: string; date: string } {
  const d = new Date(dateStr + 'T00:00:00')
  return {
    weekday: d.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase(),
    date:    d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
  }
}

function formatPeriodLabel(startStr: string, endStr: string): string {
  const s = new Date(startStr + 'T00:00:00')
  const e = new Date(endStr   + 'T00:00:00')
  const startLabel = s.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const endLabel   = e.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  return `${startLabel} — ${endLabel}`.toUpperCase()
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

interface Booking4WeekViewProps {
  companyId: string
  initialBookings: Booking[]
  /** Monday that starts the 4-week period — "YYYY-MM-DD" */
  periodStart: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Booking4WeekView({
  companyId,
  initialBookings,
  periodStart,
}: Booking4WeekViewProps) {
  const router = useRouter()

  const days    = useMemo(() => get28Days(periodStart), [periodStart])
  const endDate = days[27]
  const today   = todayString()

  const { bookings: liveBookings, loading } = useBookings(companyId, {
    startDate: periodStart,
    endDate:   endDate,
  })

  const bookings = loading ? initialBookings : liveBookings

  function bookingsForDay(dayStr: string): Booking[] {
    return bookings.filter(
      (b) => b.startDate <= dayStr && b.endDate >= dayStr && b.status !== 'cancelled',
    )
  }

  // Navigation: shift by 28 days
  function prevPeriod(): string {
    const d = new Date(periodStart + 'T00:00:00')
    d.setDate(d.getDate() - 28)
    return toDateString(d)
  }

  function nextPeriod(): string {
    const d = new Date(periodStart + 'T00:00:00')
    d.setDate(d.getDate() + 28)
    return toDateString(d)
  }

  function navigate(start: string) {
    router.push(`/bookings/4weeks?start=${start}`)
  }

  function goToToday() {
    const monday = getMondayOf(todayString())
    navigate(toDateString(monday))
  }

  // Split 28 days into 4 rows of 7
  const weeks: string[][] = []
  for (let i = 0; i < 4; i++) {
    weeks.push(days.slice(i * 7, i * 7 + 7))
  }

  const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

  return (
    <div className={styles.container}>
      {/* Nav bar */}
      <div className={styles.navBar}>
        <button className={styles.navBtn} onClick={() => navigate(prevPeriod())}>←</button>
        <span className={styles.periodLabel}>{formatPeriodLabel(periodStart, endDate)}</span>
        <button className={styles.navBtn} onClick={() => navigate(nextPeriod())}>→</button>
        <button className={styles.todayBtn} onClick={goToToday}>Today</button>
      </div>

      {/* Grid: header row + 4 week rows */}
      <div className={styles.grid}>
        {/* Weekday headers */}
        {WEEKDAYS.map((wd) => (
          <div key={wd} className={styles.dayHeader}>{wd}</div>
        ))}

        {/* Day cells — 4 rows */}
        {days.map((dayStr) => {
          const isToday     = dayStr === today
          const dayBookings = bookingsForDay(dayStr)
          const h           = formatDayHeader(dayStr)

          return (
            <div
              key={dayStr}
              className={`${styles.day} ${isToday ? styles.dayToday : ''}`}
            >
              <div className={styles.dayMeta}>
                <span className={styles.dayWeekday}>{h.weekday}</span>
                <span className={`${styles.dayDate} ${isToday ? styles.dayDateToday : ''}`}>
                  {h.date}
                </span>
              </div>
              <div className={styles.dayBookings}>
                {dayBookings.slice(0, 2).map((booking) => (
                  <Link
                    key={booking.id}
                    href={`/bookings/${booking.id}`}
                    className={`${styles.block} ${statusClass(booking.status)}`}
                  >
                    {booking.projectName}
                  </Link>
                ))}
                {dayBookings.length > 2 && (
                  <span className={styles.moreBookings}>+{dayBookings.length - 2}</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
