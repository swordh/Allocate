'use client'

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useBookings } from '@/hooks/useBookings'
import BookingStatusBadge from './BookingStatusBadge'
import type { Booking } from '@/types'
import styles from './BookingWeekView.module.css'

interface BookingWeekViewProps {
  companyId: string
  initialBookings: Booking[]
  weekNumber: number
  year: number
  weekStart: string  // "YYYY-MM-DD"
  weekEnd: string    // "YYYY-MM-DD"
}

// ---------------------------------------------------------------------------
// Day column helpers
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

function formatDayHeader(dateStr: string): { weekday: string; date: string } {
  const d = new Date(dateStr + 'T00:00:00')
  return {
    weekday: d.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase(),
    date:    d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
  }
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

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

function adjacentWeek(
  weekStart: string,
  direction: 'prev' | 'next',
): { week: number; year: number } {
  const d = new Date(weekStart + 'T00:00:00')
  d.setDate(d.getDate() + (direction === 'next' ? 7 : -7))
  return { week: getISOWeek(d), year: d.getFullYear() }
}

function formatMonthYear(weekStart: string): string {
  const d = new Date(weekStart + 'T00:00:00')
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function BookingWeekView({
  companyId,
  initialBookings,
  weekNumber,
  year,
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

  // Group bookings by which days they span
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

  return (
    <div className={styles.container}>
      {/* Week nav bar */}
      <div className={styles.navBar}>
        <button
          className={styles.navBtn}
          onClick={() => navigate(prevWeek.week, prevWeek.year)}
        >
          ←
        </button>
        <span className={styles.weekLabel}>
          W.{String(weekNumber).padStart(2, '0')} — {formatMonthYear(weekStart)}
        </span>
        <button
          className={styles.navBtn}
          onClick={() => navigate(nextWeek.week, nextWeek.year)}
        >
          →
        </button>
        <button
          className={styles.todayBtn}
          onClick={() => {
            const w = getISOWeek(new Date())
            const y = new Date().getFullYear()
            navigate(w, y)
          }}
        >
          Today
        </button>
      </div>

      {/* Grid */}
      <div className={styles.grid}>
        {days.map((day) => {
          const isToday   = day === today
          const dayBookings = bookingsForDay(day)
          const header    = formatDayHeader(day)

          return (
            <div
              key={day}
              className={`${styles.column} ${isToday ? styles.columnToday : ''}`}
            >
              <div className={styles.columnHeader}>
                <span className={styles.columnWeekday}>{header.weekday}</span>
                <span className={`${styles.columnDate} ${isToday ? styles.columnDateToday : ''}`}>
                  {header.date}
                </span>
              </div>
              <div className={styles.columnBody}>
                {dayBookings.length === 0 ? (
                  <div className={styles.emptyDay} />
                ) : (
                  dayBookings.map((booking) => (
                    <BookingBlock key={booking.id} booking={booking} />
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Empty state if no bookings at all */}
      {bookings.filter((b) => b.status !== 'cancelled').length === 0 && (
        <div className={styles.emptyState}>
          <p>No bookings this week.</p>
          <Link href="/bookings/new" className={styles.emptyAction}>
            New Booking
          </Link>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Booking block within a day column
// ---------------------------------------------------------------------------

function BookingBlock({ booking }: { booking: Booking }) {
  return (
    <Link href={`/bookings/${booking.id}`} className={styles.block}>
      <div className={styles.blockProject}>{booking.projectName}</div>
      <div className={styles.blockMeta}>
        <BookingStatusBadge
          status={booking.status}
          approvalStatus={booking.approvalStatus}
        />
      </div>
    </Link>
  )
}
