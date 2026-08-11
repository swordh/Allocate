'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { GroupedVirtuoso, type GroupedVirtuosoHandle } from 'react-virtuoso'
import Icon from '@/components/ui/Icon'
import Chip from '@/components/ui/Chip'
import Glyph from '@/components/ui/Glyph'
import StatusDot from '@/components/ui/StatusDot'
import EmptyState from '@/components/ui/EmptyState'
import { useBookings } from '@/hooks/useBookings'
import { useBookingFilters, applyOwnerFilter } from '@/hooks/useBookingFilters'
import {
  formatCompactRange,
  formatDayLabel,
  formatMonthLabel,
  parseDateString,
} from '@/lib/dates'
import { itemCount, statusColor, statusLabel } from '@/lib/bookings/status'
import BookingsToolbar from './BookingsToolbar'
import { ownerLabel } from './owner'
import type { Booking, Role, UserProfile } from '@/types'
import styles from './BookingList.module.css'

interface BookingListProps {
  companyId: string
  userId: string
  role: Role
  today: string
  /** Lower bound of the feed, matching the server's window. */
  historyStart: string
  initialBookings: Booking[]
  userProfiles: Record<string, UserProfile | null>
}

/**
 * List view — screen 08. Not a table: a stream grouped by day, with a density
 * toggle that shrinks row height, title size and spacing in one go.
 */
export default function BookingList({
  companyId,
  userId,
  today,
  historyStart,
  initialBookings,
  userProfiles,
}: BookingListProps) {
  const { showCancelled, onlyMine } = useBookingFilters()
  const [compact, setCompact] = useState(false)
  const virtuosoRef = useRef<GroupedVirtuosoHandle>(null)

  const { bookings: live, loading, error } = useBookings(companyId, {
    includeCancelled: showCancelled,
    startDate: historyStart,
  })

  const bookings = applyOwnerFilter(loading ? initialBookings : live, onlyMine, userId)

  // Grouped by start date, oldest first — the feed reads forwards.
  const { groupDates, groupCounts, flat } = useMemo(() => {
    const map = new Map<string, Booking[]>()
    for (const booking of bookings) {
      const group = map.get(booking.startDate)
      if (group) group.push(booking)
      else map.set(booking.startDate, [booking])
    }
    const dates = Array.from(map.keys()).sort()
    return {
      groupDates: dates,
      groupCounts: dates.map((d) => map.get(d)!.length),
      flat: dates.flatMap((d) => map.get(d)!),
    }
  }, [bookings])

  /** First item on or after today — the initial scroll anchor and TODAY target. */
  const todayIndex = useMemo(() => {
    let offset = 0
    for (let i = 0; i < groupDates.length; i++) {
      if (groupDates[i] >= today) return offset
      offset += groupCounts[i]
    }
    return Math.max(0, flat.length - 1)
  }, [groupDates, groupCounts, flat.length, today])

  // The design's toolbar reads "JUNE 2026 · 4 BOOKINGS" — the month you are
  // looking at, not the month it happens to be. The feed has no stepper, so the
  // topmost visible group is what names it.
  const [topItem, setTopItem] = useState(0)

  const { monthLabel, monthCount } = useMemo(() => {
    let groupIndex = 0
    let offset = 0
    for (let i = 0; i < groupCounts.length; i++) {
      if (topItem < offset + groupCounts[i]) { groupIndex = i; break }
      offset += groupCounts[i]
    }
    const anchor = groupDates[groupIndex] ?? today
    const date = parseDateString(anchor)
    const prefix = anchor.slice(0, 7)
    return {
      monthLabel: formatMonthLabel(date.getUTCFullYear(), date.getUTCMonth()),
      monthCount: bookings.filter((b) => b.startDate.startsWith(prefix)).length,
    }
  }, [topItem, groupCounts, groupDates, bookings, today])

  if (error) {
    return <p className={styles.error}>Failed to load bookings. Please refresh.</p>
  }

  return (
    <>
      <BookingsToolbar
        view="list"
        label={monthLabel}
        count={monthCount}
        onToday={() =>
          virtuosoRef.current?.scrollToIndex({ index: todayIndex, align: 'start', behavior: 'smooth' })
        }
        extraFilters={
          <Chip className={styles.compactChip} active={compact} onClick={() => setCompact((c) => !c)}>
            {compact ? 'COMPACT' : 'COMPACT LIST'}
          </Chip>
        }
      />

      {groupDates.length === 0 && !loading && (
        <EmptyState
          variant="framed"
          heading="No bookings yet"
          body="Create your first booking to get started."
          action={
            <Link href="/bookings/new" className={styles.emptyAction}>
              NEW BOOKING
            </Link>
          }
        />
      )}

      {/* Mounted only once the listener has fired, so Virtuoso gets a stable
          dataset and the right initial index on its first render. */}
      {groupDates.length > 0 && (
        <div className={`${styles.feed} ${compact ? styles.feedCompact : ''}`}>
          <GroupedVirtuoso
            ref={virtuosoRef}
            style={{ height: 'calc(100svh - 190px)', minHeight: '320px' }}
            groupCounts={groupCounts}
            initialTopMostItemIndex={todayIndex}
            rangeChanged={({ startIndex }) => setTopItem(startIndex)}
            groupContent={(index) => (
              <div className={styles.groupHeader}>
                <span className={`${styles.groupLabel} ${groupDates[index] === today ? styles.groupLabelToday : ''}`}>
                  {formatDayLabel(groupDates[index])}
                </span>
                <span className={styles.groupRule} />
              </div>
            )}
            itemContent={(index) => {
              const booking = flat[index]
              if (!booking) return <div />
              return (
                <div className={styles.rowWrap}>
                  <BookingRow
                    booking={booking}
                    userId={userId}
                    userProfiles={userProfiles}
                  />
                </div>
              )
            }}
          />
        </div>
      )}
    </>
  )
}

function BookingRow({
  booking,
  userId,
  userProfiles,
}: {
  booking: Booking
  userId: string
  userProfiles: Record<string, UserProfile | null>
}) {
  const color = statusColor(booking.status)
  const owner = ownerLabel(booking, userId, userProfiles)
  const when = formatWhen(booking)

  // Returned and cancelled bookings collapse to a single faded line — they are
  // history, and the design gives them a row of their own.
  if (booking.status === 'returned' || booking.status === 'cancelled') {
    return (
      <Link
        href={`/bookings/${booking.id}`}
        className={`${styles.row} ${styles.rowDone}`}
        style={{ borderLeftColor: color }}
      >
        <span className={styles.doneLine}>
          <span className={styles.doneTitle}>{booking.projectName}</span>
          <span className={styles.doneStatus}>
            <StatusDot size={6} />
            {statusLabel(booking.status)}
          </span>
          <span className={styles.doneMeta}>
            {when} · {owner}
          </span>
        </span>
        <Glyph char="›" className={styles.chevron} />
      </Link>
    )
  }

  return (
    <Link href={`/bookings/${booking.id}`} className={styles.row} style={{ borderLeftColor: color }}>
      <span className={styles.rowMain}>
        <span className={styles.title}>{booking.projectName}</span>
        <span className={styles.meta}>
          <span className={styles.status} style={{ color }}>
            <StatusDot size={7} />
            {statusLabel(booking.status)}
          </span>
          <span className={styles.metaItem}>
            <Icon name="schedule" size={13} strokeWidth={2} aria-hidden />
            {when}
          </span>
          <span className={styles.metaItem}>
            <Icon name="person" size={13} strokeWidth={2} aria-hidden />
            {owner}
          </span>
          <span className={styles.metaItem}>
            <Icon name="crate" size={13} strokeWidth={2} aria-hidden />
            {itemCount(booking)} items
          </span>
        </span>
      </span>
      <Glyph char="›" className={styles.chevron} />
    </Link>
  )
}

/**
 * "12 JUN", "12–14 JUN", or "12 JUN 08:00 → 18:00" when times are set.
 *
 * `startTime`/`endTime` are wall-clock strings already expressed in the
 * company's timezone — whoever made the booking typed them there — so they are
 * printed verbatim. Converting them again would shift the booking.
 */
function formatWhen(booking: Booking): string {
  const range = formatCompactRange(booking.startDate, booking.endDate)
  if (!booking.startTime || !booking.endTime) return range
  return `${range} ${booking.startTime} → ${booking.endTime}`
}
