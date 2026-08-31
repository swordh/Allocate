'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Icon from '@/components/ui/Icon'
import StatusDot from '@/components/ui/StatusDot'
import { useBookings } from '@/hooks/useBookings'
import { useBookingFilters, applyOwnerFilter } from '@/hooks/useBookingFilters'
import {
  WEEKDAYS_NARROW,
  WEEKDAYS_SHORT,
  formatCompactRange,
  formatDayLabel,
  formatMonthLabel,
  formatSpanLabel,
  getISOWeek,
  getISOWeekYear,
  getMondayString,
  isWeekend,
  offsetDate,
  parseDateString,
  toDateString,
} from '@/lib/dates'
import { bookingsForDay, itemCount, packIntoLanes, positionBookings, statusColor, statusLabel } from '@/lib/bookings/status'
import BookingsToolbar from './BookingsToolbar'
import { ownerLabel } from './owner'
import type { Booking, UserProfile } from '@/types'
import styles from './BookingMonthView.module.css'

/** Lanes drawn per week row before the rest collapse into "+N more". */
const MAX_LANES = 4

/** Status dots drawn per day cell on mobile before they collapse into "+N". */
const MAX_DOTS = 3

interface BookingMonthViewProps {
  /**
   * 4 WEEKS is this same view with a shifted window — four week rows from the
   * current week's Monday, no out-of-month dimming (decision 6). There is no
   * separate design for it.
   */
  mode: 'month' | '4weeks'
  companyId: string
  userId: string
  today: string
  initialBookings: Booking[]
  userProfiles: Record<string, UserProfile | null>
  /** Month mode only, for the "JUNE 2026" label and the out-of-month test. */
  year?: number
  month?: number
  periodStart: string
  periodEnd: string
}

/** Month view — screen 07. Week rows of bars on desktop, day dots on mobile. */
export default function BookingMonthView({
  mode,
  companyId,
  userId,
  today,
  initialBookings,
  userProfiles,
  year,
  month,
  periodStart,
  periodEnd,
}: BookingMonthViewProps) {
  const router = useRouter()
  const { showCancelled, onlyMine, filterParams } = useBookingFilters()

  const gridStart = getMondayString(periodStart)
  const rowCount = mode === '4weeks'
    ? 4
    : Math.ceil(
        (Math.round((parseDateString(periodEnd).getTime() - parseDateString(gridStart).getTime()) / 86_400_000) + 1) / 7,
      )
  const gridEnd = offsetDate(gridStart, rowCount * 7 - 1)

  const { bookings: live, loading } = useBookings(companyId, {
    startDate: gridStart,
    endDate: gridEnd,
    includeCancelled: showCancelled,
  })

  const bookings = applyOwnerFilter(loading ? initialBookings : live, onlyMine, userId)

  // The agenda under the mobile grid needs a day to show. Today when the period
  // contains it, otherwise the first day that actually has something on it —
  // landing on an empty 1st of the month tells the reader nothing.
  const [selectedDay, setSelectedDay] = useState(() => {
    if (today >= gridStart && today <= gridEnd) return today
    const firstBooked = initialBookings
      .map((b) => (b.startDate < periodStart ? periodStart : b.startDate))
      .filter((d) => d <= periodEnd)
      .sort()[0]
    return firstBooked ?? periodStart
  })

  const weeks = useMemo(() => {
    return Array.from({ length: rowCount }, (_, row) => {
      const rowStart = offsetDate(gridStart, row * 7)
      const rowEnd = offsetDate(rowStart, 6)
      const days = Array.from({ length: 7 }, (_, col) => {
        const date = offsetDate(rowStart, col)
        const inPeriod = date >= periodStart && date <= periodEnd
        return {
          date,
          dayNumber: parseDateString(date).getUTCDate(),
          inPeriod,
          isToday: date === today,
          weekend: isWeekend(date),
          dayBookings: bookingsForDay(bookings, date),
        }
      })

      // Bars are clipped to this row; a booking spanning several weeks appears
      // once per row it touches.
      const packed = packIntoLanes(positionBookings(bookings, rowStart, rowEnd))
      const bars = packed.filter((b) => b.lane < MAX_LANES)

      // Everything past the lane cap becomes a per-column "+N more".
      const overflowByColumn = new Array(7).fill(0)
      for (const bar of packed.filter((b) => b.lane >= MAX_LANES)) {
        for (let c = bar.colStart; c < bar.colStart + bar.colSpan; c++) overflowByColumn[c]++
      }

      return {
        key: rowStart,
        weekNumber: getISOWeek(rowStart),
        days,
        bars,
        overflow: overflowByColumn
          .map((count, col) => ({ col, count }))
          .filter((o) => o.count > 0),
      }
    })
  }, [bookings, gridStart, rowCount, periodStart, periodEnd, today])

  const label = mode === 'month' && year !== undefined && month !== undefined
    ? formatMonthLabel(year, month - 1)
    : formatSpanLabel(periodStart, periodEnd)

  function goTo(start: string) {
    const params = new URLSearchParams(filterParams)
    if (mode === '4weeks') {
      params.set('start', getMondayString(start))
      router.push(`/bookings/4weeks?${params}`)
      return
    }
    const d = parseDateString(start)
    params.set('year', String(d.getUTCFullYear()))
    params.set('month', String(d.getUTCMonth() + 1))
    router.push(`/bookings/month?${params}`)
  }

  function step(delta: number) {
    if (mode === '4weeks') {
      goTo(offsetDate(periodStart, delta * 28))
      return
    }
    const d = parseDateString(periodStart)
    goTo(toDateString(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1))))
  }

  const agenda = bookingsForDay(bookings, selectedDay)

  return (
    <>
      <BookingsToolbar
        view={mode === '4weeks' ? '4weeks' : 'month'}
        label={label}
        count={bookings.length}
        onPrev={() => step(-1)}
        onNext={() => step(1)}
        onToday={() => goTo(today)}
      />

      {/* ── desktop: week rows of bars ───────────────────────────────────── */}
      <div className={styles.desktop}>
        <div className={styles.weekdayHeader}>
          <div className={styles.gutterHead} />
          {WEEKDAYS_SHORT.map((day, i) => (
            <div key={day} className={styles.weekdayCell}>
              <span className={`${styles.weekday} ${i >= 5 ? styles.weekdayWeekend : ''}`}>{day}</span>
            </div>
          ))}
        </div>

        {weeks.map((week) => (
          <div key={week.key} className={styles.weekRow}>
            <div className={styles.dayLayer} aria-hidden="true">
              <div className={styles.gutter}>W{week.weekNumber}</div>
              {week.days.map((day) => (
                <div
                  key={day.date}
                  className={`${styles.dayCell} ${
                    day.isToday ? styles.dayCellToday : day.weekend ? styles.dayCellWeekend : ''
                  }`}
                >
                  <span
                    className={`${styles.dayNumber} ${day.isToday ? styles.dayNumberToday : ''} ${
                      !day.inPeriod ? styles.dayNumberOutside : day.weekend ? styles.dayNumberWeekend : ''
                    }`}
                  >
                    {day.dayNumber}
                  </span>
                </div>
              ))}
            </div>

            <div className={styles.barLayer}>
              <div className={styles.barGrid}>
                {week.bars.map(({ booking, colStart, colSpan, lane }) => {
                  const color = statusColor(booking.status)
                  const muted = booking.status === 'returned' || booking.status === 'cancelled'
                  return (
                    <Link
                      key={`${week.key}-${booking.id}`}
                      href={`/bookings/${booking.id}`}
                      className={`${styles.bar} ${muted ? styles.barMuted : ''}`}
                      style={{
                        gridColumn: `${colStart + 1} / span ${colSpan}`,
                        gridRow: lane + 1,
                        borderLeftColor: color,
                      }}
                    >
                      <StatusDot size={5} color={color} className={styles.barDot} />
                      <span className={styles.barTitle}>{booking.projectName}</span>
                      {colSpan >= 2 && (
                        <span className={styles.barMeta}>{ownerLabel(booking, userId, userProfiles)}</span>
                      )}
                    </Link>
                  )
                })}

                {/* The bars layer is desktop-only, so this takes you to the
                    week view for that day — where every lane fits — rather
                    than to the mobile agenda, which is not on screen here. */}
                {week.overflow.map((o) => {
                  const day = offsetDate(week.key, o.col)
                  const params = new URLSearchParams(filterParams)
                  params.set('week', String(getISOWeek(day)))
                  params.set('year', String(getISOWeekYear(day)))
                  return (
                    <Link
                      key={`${week.key}-more-${o.col}`}
                      href={`/bookings/week?${params}`}
                      className={styles.more}
                      style={{ gridColumn: o.col + 1, gridRow: MAX_LANES + 1 }}
                    >
                      +{o.count} more
                    </Link>
                  )
                })}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── mobile: day dots + an agenda for the selected day ────────────── */}
      <div className={styles.mobile}>
        <div className={styles.narrowHeader} aria-hidden="true">
          {WEEKDAYS_NARROW.map((day, i) => (
            <span key={i} className={`${styles.weekday} ${i >= 5 ? styles.weekdayWeekend : ''}`}>
              {day}
            </span>
          ))}
        </div>

        <div className={styles.cellGrid}>
          {weeks.flatMap((week) =>
            week.days.map((day) => {
              const dots = day.dayBookings.slice(0, MAX_DOTS)
              const more = day.dayBookings.length - dots.length
              return (
                <button
                  key={day.date}
                  type="button"
                  disabled={!day.inPeriod}
                  onClick={() => setSelectedDay(day.date)}
                  aria-pressed={day.date === selectedDay}
                  className={`${styles.cell} ${day.date === selectedDay ? styles.cellSelected : ''} ${
                    !day.inPeriod ? styles.cellOutside : day.weekend ? styles.cellWeekend : ''
                  }`}
                >
                  <span
                    className={`${styles.cellNumber} ${day.isToday ? styles.dayNumberToday : ''} ${
                      !day.inPeriod ? styles.dayNumberOutside : day.weekend ? styles.dayNumberWeekend : ''
                    }`}
                  >
                    {day.dayNumber}
                  </span>
                  <span className={styles.dots}>
                    {dots.map((b) => (
                      <StatusDot key={b.id} size={5} color={statusColor(b.status)} />
                    ))}
                    {more > 0 && <span className={styles.dotsMore}>+{more}</span>}
                  </span>
                </button>
              )
            }),
          )}
        </div>

        <div className={styles.agenda}>
          <p className={styles.agendaHead}>{formatDayLabel(selectedDay)}</p>

          {agenda.length === 0 && <p className={styles.agendaEmpty}>No bookings this day</p>}

          {agenda.map((booking) => {
            const color = statusColor(booking.status)
            const muted = booking.status === 'returned' || booking.status === 'cancelled'
            return (
              <Link
                key={booking.id}
                href={`/bookings/${booking.id}`}
                className={`${styles.agendaRow} ${muted ? styles.agendaRowMuted : ''}`}
                style={{ borderLeftColor: color }}
              >
                <span className={styles.agendaMain}>
                  <span className={styles.agendaTitle}>{booking.projectName}</span>
                  <span className={styles.agendaMeta}>
                    <span className={styles.status} style={{ color }}>
                      <StatusDot size={5} />
                      {statusLabel(booking.status)}
                    </span>
                    <span className={styles.metaItem}>
                      <Icon name="crate" size={10} strokeWidth={2} aria-hidden />
                      {itemCount(booking)}
                    </span>
                  </span>
                </span>

                {booking.startDate !== booking.endDate && (
                  <span className={styles.agendaRange} style={{ color }}>
                    {formatCompactRange(booking.startDate, booking.endDate)}
                  </span>
                )}
                <span className={styles.agendaOwner}>{ownerLabel(booking, userId, userProfiles)}</span>
              </Link>
            )
          })}
        </div>
      </div>
    </>
  )
}
