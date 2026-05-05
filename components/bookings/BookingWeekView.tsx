'use client'

import { useMemo, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useBookings } from '@/hooks/useBookings'
import type { Booking } from '@/types'
import styles from './BookingWeekView.module.css'

// ---------------------------------------------------------------------------
// Time grid constants
// ---------------------------------------------------------------------------

const START_HOUR = 0
const END_HOUR   = 24
const HOURS      = END_HOUR - START_HOUR  // 24
const CELL_H     = 48
const TOTAL_H    = HOURS * CELL_H         // 1152px

function timeToTop(time: string | null | undefined): number {
  if (!time) return 0
  const [h, m] = time.split(':').map(Number)
  return ((h - START_HOUR) + m / 60) * CELL_H
}

function timeToPx(start: string | null | undefined, end: string | null | undefined): number {
  if (!start || !end) return TOTAL_H
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  return ((eh - sh) + (em - sm) / 60) * CELL_H
}

function statusClass(status: string): string {
  switch (status) {
    case 'checked_out': return styles.blockCheckedOut
    case 'confirmed':   return styles.blockConfirmed
    case 'returned':    return styles.blockReturned
    default:            return styles.blockPending
  }
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function getDaysOfWeek(weekStart: string): string[] {
  const days: string[] = []
  const start = new Date(weekStart + 'T00:00:00')
  for (let i = 0; i < 7; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    days.push(toDateString(d))
  }
  return days
}

function toDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function todayString(): string {
  return toDateString(new Date())
}

function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr + 'T00:00:00').getDay()
  return d === 0 || d === 6
}

function getISOWeek(date: Date): number {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7))
  const week1 = new Date(d.getFullYear(), 0, 4)
  return (
    1 +
    Math.round(
      ((d.getTime() - week1.getTime()) / 86400000 -
        3 +
        ((week1.getDay() + 6) % 7)) /
        7,
    )
  )
}

function adjacentWeek(weekStart: string, direction: 'prev' | 'next'): { week: number; year: number } {
  const d = new Date(weekStart + 'T00:00:00')
  d.setDate(d.getDate() + (direction === 'next' ? 7 : -7))
  return { week: getISOWeek(d), year: d.getFullYear() }
}

function formatMonthYear(weekStart: string): string {
  const d = new Date(weekStart + 'T00:00:00')
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface BookingWeekViewProps {
  companyId: string
  initialBookings: Booking[]
  weekNumber: number
  year: number
  weekStart: string
  weekEnd: string
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ColHeader({ day, isToday, weekend }: { day: string; isToday: boolean; weekend: boolean }) {
  const d    = new Date(day + 'T00:00:00')
  const num  = d.getDate()
  const abbr = d.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase()
  return (
    <div className={[styles.colHeader, isToday ? styles.colHeaderToday : '', weekend ? styles.colHeaderWeekend : ''].join(' ')}>
      <span className={styles.colHeaderDayNum}>{num}</span>
      <span className={styles.colHeaderWeekday}>{abbr}</span>
    </div>
  )
}

function CurrentTimeLine() {
  const now = new Date()
  const top = ((now.getHours() - START_HOUR) + now.getMinutes() / 60) * CELL_H
  return (
    <div className={styles.timeLine} style={{ top }}>
      <div className={styles.timeLineDot} />
    </div>
  )
}

function BookingBlock({ booking }: { booking: Booking }) {
  const top    = timeToTop(booking.startTime)
  const height = Math.max(timeToPx(booking.startTime, booking.endTime), 20)
  return (
    <Link
      href={`/bookings/${booking.id}`}
      className={`${styles.bookingBlock} ${statusClass(booking.status)}`}
      style={{ top, height }}
    >
      {booking.projectName}
    </Link>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function BookingWeekView({
  companyId,
  initialBookings,
  weekNumber,
  weekStart,
  weekEnd,
}: BookingWeekViewProps) {
  const router = useRouter()

  const { bookings: liveBookings, loading } = useBookings(companyId, {
    startDate: weekStart,
    endDate:   weekEnd,
  })

  const bookings = loading ? initialBookings : liveBookings
  const days     = useMemo(() => getDaysOfWeek(weekStart), [weekStart])
  const today    = todayString()

  function bookingsForDay(dayStr: string): Booking[] {
    return bookings.filter(
      (b) => b.startDate <= dayStr && b.endDate >= dayStr && b.status !== 'cancelled',
    )
  }

  // Week nav
  const prevWeek = adjacentWeek(weekStart, 'prev')
  const nextWeek = adjacentWeek(weekStart, 'next')

  function navigate(week: number, yr: number) {
    router.push(`/bookings/week?week=${week}&year=${yr}`)
  }

  const dateInputRef = useRef<HTMLInputElement>(null)

  // Auto-scroll to current time (or 07:00 for non-current weeks)
  const calWrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (days.includes(today)) {
      const now     = new Date()
      const lineTop = (now.getHours() + now.getMinutes() / 60) * CELL_H
      calWrapRef.current?.scrollTo({ top: Math.max(0, lineTop - 100) })
    } else {
      calWrapRef.current?.scrollTo({ top: Math.max(0, 7 * CELL_H - 100) })
    }
  }, [weekStart]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={styles.container}>
      {/* Nav bar */}
      <div className={styles.navBar}>
        <button className={styles.navBtn} onClick={() => navigate(prevWeek.week, prevWeek.year)}>←</button>
        <button className={styles.weekLabel} onClick={() => {
          try { dateInputRef.current?.showPicker() }
          catch { dateInputRef.current?.focus() }
        }}>
          W.{String(weekNumber).padStart(2, '0')} — {formatMonthYear(weekStart)}
        </button>
        <input
          ref={dateInputRef}
          type="date"
          onChange={(e) => {
            if (!e.target.value) return
            const d = new Date(e.target.value + 'T00:00:00')
            navigate(getISOWeek(d), d.getFullYear())
          }}
          className={styles.hiddenDateInput}
        />
        <button className={styles.navBtn} onClick={() => navigate(nextWeek.week, nextWeek.year)}>→</button>
        <button
          className={styles.todayBtn}
          onClick={() => navigate(getISOWeek(new Date()), new Date().getFullYear())}
        >
          Today
        </button>
      </div>

      {/* Time-grid calendar — horizontally scrollable on mobile */}
      <div className={styles.calWrap} ref={calWrapRef}>
        <div className={styles.calGrid}>
          {/* Header row: empty corner + 7 day headers */}
          <div className={styles.cornerHeader} />
          {days.map((day) => (
            <ColHeader
              key={day}
              day={day}
              isToday={day === today}
              weekend={isWeekend(day)}
            />
          ))}

          {/* Time column */}
          <div className={styles.timeCol}>
            {Array.from({ length: HOURS }, (_, i) => (
              <div key={i} className={styles.timeLabel}>
                {String(START_HOUR + i).padStart(2, '0')}:00
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map((day) => (
            <div
              key={day}
              className={`${styles.dayCol} ${isWeekend(day) ? styles.dayColWeekend : ''}`}
            style={{ height: TOTAL_H }}
            >
              {Array.from({ length: HOURS }, (_, i) => (
                <div key={i} className={styles.hourCell}>
                  <div className={styles.halfLine} />
                </div>
              ))}
              {bookingsForDay(day).map((b) => (
                <BookingBlock key={b.id} booking={b} />
              ))}
              {day === today && <CurrentTimeLine />}
            </div>
          ))}
        </div>
      </div>

      {/* Empty state */}
      {bookings.filter((b) => b.status !== 'cancelled').length === 0 && (
        <div className={styles.emptyState}>
          <p>No bookings this week.</p>
          <Link href="/bookings/new" className={styles.emptyAction}>New Booking</Link>
        </div>
      )}
    </div>
  )
}
