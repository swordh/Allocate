'use client'

import { useMemo, type CSSProperties } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Icon from '@/components/ui/Icon'
import Glyph from '@/components/ui/Glyph'
import StatusDot from '@/components/ui/StatusDot'
import { useBookings } from '@/hooks/useBookings'
import { useBookingFilters, applyOwnerFilter } from '@/hooks/useBookingFilters'
import {
  WEEKDAYS_SHORT,
  formatCompactRange,
  formatSpanLabel,
  getISOWeek,
  getISOWeekYear,
  isWeekend,
  offsetDate,
  parseDateString,
} from '@/lib/dates'
import { itemCount, packIntoLanes, statusColor, statusLabel } from '@/lib/bookings/status'
import BookingsToolbar from './BookingsToolbar'
import WeekDatePicker from './WeekDatePicker'
import { ownerLabel } from './owner'
import type { Booking, UserProfile } from '@/types'
import styles from './BookingWeekView.module.css'

interface BookingWeekViewProps {
  companyId: string
  userId: string
  today: string
  initialBookings: Booking[]
  userProfiles: Record<string, UserProfile | null>
  weekNumber: number
  year: number
  weekStart: string
  weekEnd: string
}

const DAY_MS = 86_400_000

/**
 * Week view — screen 06.
 *
 * Seven day columns, no time axis. A booking is one block spanning whole days;
 * blocks that would collide are packed into lanes, and a booking that runs past
 * either edge of the week is drawn flush to that edge with its full range shown
 * as text rather than being cut off silently.
 */
export default function BookingWeekView({
  companyId,
  userId,
  today,
  initialBookings,
  userProfiles,
  weekNumber,
  weekStart,
  weekEnd,
}: BookingWeekViewProps) {
  const router = useRouter()
  const { showCancelled, onlyMine, filterParams } = useBookingFilters()

  const { bookings: live, loading } = useBookings(companyId, {
    startDate: weekStart,
    endDate: weekEnd,
    includeCancelled: showCancelled,
  })

  // The server-rendered seed covers the first paint; after that the listener is
  // authoritative, including when it legitimately returns nothing.
  const bookings = applyOwnerFilter(loading ? initialBookings : live, onlyMine, userId)

  const days = useMemo(
    () =>
      WEEKDAYS_SHORT.map((dow, i) => {
        const date = offsetDate(weekStart, i)
        return {
          dow,
          date,
          dayNumber: parseDateString(date).getUTCDate(),
          isToday: date === today,
          weekend: isWeekend(date),
        }
      }),
    [weekStart, today],
  )

  const blocks = useMemo(() => {
    const weekStartMs = parseDateString(weekStart).getTime()

    const positioned = bookings
      .filter((b) => b.startDate <= weekEnd && b.endDate >= weekStart)
      .map((booking) => {
        const from = booking.startDate < weekStart ? weekStart : booking.startDate
        const to = booking.endDate > weekEnd ? weekEnd : booking.endDate
        const colStart = Math.round((parseDateString(from).getTime() - weekStartMs) / DAY_MS)
        const colEnd = Math.round((parseDateString(to).getTime() - weekStartMs) / DAY_MS)
        return {
          booking,
          colStart,
          colSpan: colEnd - colStart + 1,
          clipLeft: booking.startDate < weekStart,
          clipRight: booking.endDate > weekEnd,
        }
      })

    return packIntoLanes(positioned)
  }, [bookings, weekStart, weekEnd])

  const laneCount = blocks.reduce((max, b) => Math.max(max, b.lane + 1), 0)

  function goToWeek(monday: string) {
    const params = new URLSearchParams(filterParams)
    params.set('week', String(getISOWeek(monday)))
    params.set('year', String(getISOWeekYear(monday)))
    router.push(`/bookings/week?${params}`)
  }

  return (
    <>
      <BookingsToolbar
        view="week"
        label={formatSpanLabel(weekStart, weekEnd)}
        count={bookings.length}
        onPrev={() => goToWeek(offsetDate(weekStart, -7))}
        onNext={() => goToWeek(offsetDate(weekStart, 7))}
        onToday={() => goToWeek(today)}
        badge={
          <WeekDatePicker
            label={`W ${weekNumber}`}
            weekStart={weekStart}
            today={today}
            onPickWeek={goToWeek}
          />
        }
      />

      <div className={styles.scroller}>
        <div className={styles.canvas}>
          <div className={styles.dayHeader}>
            {days.map((day) => (
              <div key={day.date} className={`${styles.dayCell} ${day.isToday ? styles.dayCellToday : ''}`}>
                <span className={styles.dow}>{day.dow}</span>
                <span className={`${styles.dayNumber} ${day.weekend ? styles.weekendNumber : ''}`}>
                  {day.dayNumber}
                </span>
              </div>
            ))}
          </div>

          {/* The block layer is absolutely positioned over the column washes so
              a multi-day block is not clipped by any single column, which means
              the columns have to be told how tall the deepest lane stack is. */}
          <div className={styles.grid} style={{ '--lanes': laneCount } as CSSProperties}>
            <div className={styles.columns} aria-hidden="true">
              {days.map((day) => (
                <div
                  key={day.date}
                  className={`${styles.column} ${
                    day.isToday ? styles.columnToday : day.weekend ? styles.columnWeekend : ''
                  }`}
                />
              ))}
            </div>

            <div className={styles.blocks}>
              {blocks.map(({ booking, colStart, colSpan, clipLeft, clipRight, lane }) => {
                const color = statusColor(booking.status)
                const muted = booking.status === 'returned' || booking.status === 'cancelled'
                return (
                  <Link
                    key={booking.id}
                    href={`/bookings/${booking.id}`}
                    className={`${styles.block} ${muted ? styles.blockMuted : ''} ${
                      clipLeft ? styles.clipLeft : ''
                    } ${clipRight ? styles.clipRight : ''}`}
                    style={{
                      gridColumn: `${colStart + 1} / span ${colSpan}`,
                      gridRow: lane + 1,
                      borderLeftColor: color,
                    }}
                  >
                    <span className={styles.blockTop}>
                      <span className={styles.blockTitle}>{booking.projectName}</span>
                      {(clipLeft || clipRight) && (
                        <span className={styles.rangeBadge} style={{ color }}>
                          {formatCompactRange(booking.startDate, booking.endDate)}
                        </span>
                      )}
                    </span>

                    <span className={styles.blockMeta}>
                      <span className={styles.status} style={{ color }}>
                        <StatusDot size={6} />
                        {statusLabel(booking.status)}
                      </span>
                      <span className={styles.metaItem}>
                        <Icon name="crate" size={11} strokeWidth={2} aria-hidden />
                        {itemCount(booking)}
                      </span>
                    </span>

                    <span className={styles.owner}>{ownerLabel(booking, userId, userProfiles)}</span>
                  </Link>
                )
              })}
            </div>
          </div>
        </div>

        <p className={styles.scrollHint} aria-hidden="true">
          <Glyph char="‹" />
          <Glyph char="›" />
          SWIPE FOR WEEK
        </p>
      </div>

      {bookings.length === 0 && (
        <p className={styles.empty}>No bookings this week</p>
      )}
    </>
  )
}
