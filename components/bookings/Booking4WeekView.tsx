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

function getMondayOf(dateStr: string): Date {
  const d   = new Date(dateStr + 'T00:00:00')
  const day = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - day)
  return d
}

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

function formatPeriodLabel(startStr: string, endStr: string): string {
  const s = new Date(startStr + 'T00:00:00')
  const e = new Date(endStr   + 'T00:00:00')
  const startLabel = s.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const endLabel   = e.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  return `${startLabel} — ${endLabel}`.toUpperCase()
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

interface Booking4WeekViewProps {
  companyId: string
  initialBookings: Booking[]
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
    navigate(toDateString(getMondayOf(todayString())))
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

      {/* Grid */}
      <div className={styles.grid}>
        {/* Weekday headers */}
        {WEEKDAYS.map((wd, i) => (
          <div key={wd} className={`${styles.dayHeader} ${i >= 5 ? styles.dayHeaderWeekend : ''}`}>
            {wd}
          </div>
        ))}

        {/* Day cells */}
        {days.map((dayStr) => {
          const isToday     = dayStr === today
          const weekend     = isWeekend(dayStr)
          const dayNum      = new Date(dayStr + 'T00:00:00').getDate()
          const dayBookings = bookingsForDay(dayStr)

          return (
            <div
              key={dayStr}
              className={[
                styles.day,
                weekend ? styles.dayWeekend : '',
                isToday ? styles.dayToday   : '',
              ].filter(Boolean).join(' ')}
            >
              <span className={`${styles.dayNum} ${isToday ? styles.dayNumToday : ''}`}>
                {dayNum}
              </span>
              <div className={styles.dayBookings}>
                {dayBookings.slice(0, 2).map((booking) => (
                  <Link
                    key={booking.id}
                    href={`/bookings/${booking.id}`}
                    className={styles.bookingRow}
                  >
                    <span className={`${styles.bookingDot} ${statusDotClass(booking.status)}`} />
                    <span className={styles.bookingName}>{booking.projectName}</span>
                  </Link>
                ))}
                {dayBookings.length > 2 && (
                  <span className={styles.moreBookings}>+{dayBookings.length - 2} more</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
