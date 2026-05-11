'use client'

import { useState, useMemo, useRef, useEffect } from 'react'
import Link from 'next/link'
import { GroupedVirtuoso, type GroupedVirtuosoHandle } from 'react-virtuoso'
import { useBookings } from '@/hooks/useBookings'
import type { Booking, Role, UserProfile } from '@/types'
import styles from './BookingList.module.css'

interface BookingListProps {
  companyId: string
  userId: string
  role: Role
  /** Bookings pre-fetched on the server for initial paint. */
  initialBookings: Booking[]
  /** UserProfile data for each userId in bookings */
  userProfiles: Record<string, UserProfile | null>
}

// ---------------------------------------------------------------------------
// Date grouping helpers
// ---------------------------------------------------------------------------

function toLocalDateString(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function groupBookingsByDate(bookings: Booking[]): Map<string, Booking[]> {
  const map = new Map<string, Booking[]>()
  for (const b of bookings) {
    const key = b.startDate
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(b)
  }
  return map
}

function formatDateLabel(dateStr: string, today: string, tomorrow: string): string {
  if (dateStr === today) return 'Today'
  if (dateStr === tomorrow) return 'Tomorrow'
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

// ---------------------------------------------------------------------------
// Stats computation
// ---------------------------------------------------------------------------

function computeStats(bookings: Booking[], today: string) {
  const todayBookings = bookings.filter(
    (b) => b.startDate <= today && b.endDate >= today && b.status !== 'cancelled',
  )
  const bookingsToday = todayBookings.length
  const itemsOut = bookings.filter(
    (b) => b.status === 'checked_out',
  ).reduce((sum, b) => sum + b.items.reduce((s, i) => s + i.quantity, 0), 0)
  const pendingApprovals = bookings.filter(
    (b) => b.status === 'pending' && b.approvalStatus === 'pending',
  ).length
  return { bookingsToday, itemsOut, pendingApprovals }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function BookingList({
  companyId,
  userId,
  role: _role,
  initialBookings,
  userProfiles,
}: BookingListProps) {
  const [showCancelled, setShowCancelled] = useState(false)
  const [showOnlyMine, setShowOnlyMine] = useState(false)

  // Load a large window so past and future bookings up to 5 years in each
  // direction are available without extra fetches.
  const fiveYearsAgo = useMemo(() => {
    const d = new Date()
    d.setFullYear(d.getFullYear() - 5)
    return d.toISOString().slice(0, 10)
  }, [])

  const { bookings: liveBookings, loading, error } = useBookings(companyId, {
    includeCancelled: showCancelled,
    startDate: fiveYearsAgo,
  })

  // Use live data once the listener has fired; fall back to server-fetched initial data.
  const bookings = loading ? initialBookings : liveBookings

  const visibleBookings = useMemo(() => {
    let result = bookings
    if (showOnlyMine && userId) {
      result = result.filter((b) => b.userId === userId)
    }
    return result
  }, [bookings, showOnlyMine, userId])

  const today    = toLocalDateString(new Date())
  const tomorrow = toLocalDateString(new Date(Date.now() + 86400000))

  // Stats are computed but stats bar is commented out per spec
  const stats = useMemo(() => computeStats(visibleBookings, today), [visibleBookings, today])
  void stats // prevent unused variable warning

  // Group by startDate, filtered, sorted oldest → newest.
  const grouped = useMemo(() => {
    const all = showCancelled
      ? visibleBookings
      : visibleBookings.filter((b) => b.status !== 'cancelled')
    return groupBookingsByDate(all)
  }, [visibleBookings, showCancelled])

  const sortedDates = useMemo(
    () => Array.from(grouped.keys()).sort((a, b) => (a > b ? 1 : -1)),
    [grouped],
  )

  // Flat booking array in date order for O(1) lookup by virtuoso index.
  const flatBookings = useMemo(
    () => sortedDates.flatMap((d) => grouped.get(d) ?? []),
    [sortedDates, grouped],
  )

  // Number of booking items per date group.
  const groupCounts = useMemo(
    () => sortedDates.map((d) => (grouped.get(d) ?? []).length),
    [sortedDates, grouped],
  )

  // Flat item index of the first booking on or after today.
  // Used for initial scroll position and the Today button.
  const todayItemIndex = useMemo(() => {
    let offset = 0
    for (let i = 0; i < sortedDates.length; i++) {
      if (sortedDates[i] >= today) return offset
      offset += groupCounts[i]
    }
    // All dates are in the past — scroll to the last item.
    return Math.max(0, flatBookings.length - 1)
  }, [sortedDates, groupCounts, flatBookings.length, today])

  const virtuosoRef = useRef<GroupedVirtuosoHandle>(null)

  // After live data loads, re-scroll to today so the position reflects the
  // full dataset (initial server data may have a different offset).
  useEffect(() => {
    if (!loading && flatBookings.length > 0) {
      virtuosoRef.current?.scrollToIndex({ index: todayItemIndex, align: 'start' })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]) // intentionally only fires when loading flips to false

  if (error) {
    return (
      <div className={styles.errorState}>
        <p>Failed to load bookings. Please refresh.</p>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      {/* Stats bar — logic preserved, UI hidden per redesign spec */}
      {/* <div className={styles.statsBar}>…</div> */}

      {/* Controls */}
      <div className={styles.controls}>
        <button
          className={`${styles.toggleBtn} ${showCancelled ? styles.toggleActive : ''}`}
          onClick={() => setShowCancelled((v) => !v)}
        >
          {showCancelled ? 'Hide cancelled' : 'Show cancelled'}
        </button>
        <button
          className={`${styles.toggleBtn} ${showOnlyMine ? styles.toggleActive : ''}`}
          onClick={() => setShowOnlyMine((v) => !v)}
        >
          {showOnlyMine ? 'Show all' : 'Only mine'}
        </button>
        <button
          className={styles.todayBtn}
          onClick={() =>
            virtuosoRef.current?.scrollToIndex({ index: todayItemIndex, align: 'start', behavior: 'smooth' })
          }
        >
          Today
        </button>
      </div>

      {/* Empty state */}
      {sortedDates.length === 0 && (
        <div className={styles.emptyState}>
          <p className={styles.emptyHeading}>No bookings yet</p>
          <p className={styles.emptyBody}>
            Create your first booking to get started.
          </p>
          <Link href="/bookings/new" className={styles.emptyAction}>
            New Booking
          </Link>
        </div>
      )}

      {/* Virtualized date-grouped list */}
      {sortedDates.length > 0 && (
        <GroupedVirtuoso
          ref={virtuosoRef}
          useWindowScroll
          groupCounts={groupCounts}
          initialTopMostItemIndex={todayItemIndex}
          groupContent={(index) => {
            const dateStr  = sortedDates[index]
            const label    = formatDateLabel(dateStr, today, tomorrow)
            const isToday  = dateStr === today
            return (
              <div className={`${styles.groupHeader} ${index === 0 ? styles.groupHeaderFirst : ''}`}>
                <span className={`${styles.dateLabel} ${isToday ? styles.dateLabelToday : ''}`}>
                  {label.toUpperCase()}
                </span>
                <div className={styles.groupRule} />
              </div>
            )
          }}
          itemContent={(index) => {
            const booking = flatBookings[index]
            if (!booking) return <div />
            return (
              <div className={styles.bookingCardWrapper}>
                <BookingRow booking={booking} userProfiles={userProfiles} />
              </div>
            )
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Booking row
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<string, string> = {
  checked_out: 'CHECKED OUT',
  confirmed:   'CONFIRMED',
  pending:     'PENDING',
  returned:    'RETURNED',
  cancelled:   'CANCELLED',
}

function getStatusLabel(booking: Booking): string {
  if (booking.status === 'pending' && booking.approvalStatus === 'rejected') return 'REJECTED'
  return STATUS_LABELS[booking.status] ?? booking.status.toUpperCase()
}

function getStatusRowClass(booking: Booking): string {
  if (booking.status === 'pending' && booking.approvalStatus === 'rejected') return styles.rowRejected
  switch (booking.status) {
    case 'checked_out': return styles.rowCheckedOut
    case 'confirmed':   return styles.rowConfirmed
    case 'pending':     return styles.rowPending
    case 'returned':    return styles.rowReturned
    case 'cancelled':   return styles.rowCancelled
    default:            return styles.rowPending
  }
}

function getStatusTextClass(booking: Booking): string {
  if (booking.status === 'pending' && booking.approvalStatus === 'rejected') return styles.statusRejected
  switch (booking.status) {
    case 'checked_out': return styles.statusCheckedOut
    case 'confirmed':   return styles.statusConfirmed
    case 'pending':     return styles.statusPending
    case 'returned':    return styles.statusReturned
    case 'cancelled':   return styles.statusCancelled
    default:            return styles.statusPending
  }
}

function BookingRow({
  booking,
  userProfiles,
}: {
  booking: Booking
  userProfiles: Record<string, UserProfile | null>
}) {
  const itemCount   = booking.items.reduce((sum, i) => sum + i.quantity, 0)
  const statusClass = getStatusRowClass(booking)
  const displayName = booking.userId
    ? (userProfiles[booking.userId]?.name ?? booking.userName)
    : booking.userName

  const timeOrDate = formatBookingDateTime(
    booking.startDate,
    booking.endDate,
    booking.startTime,
    booking.endTime,
  )

  return (
    <Link
      href={`/bookings/${booking.id}`}
      className={`${styles.row} ${statusClass}`}
    >
      <div className={styles.rowLeft}>
        <span className={styles.rowProject}>{booking.projectName}</span>
        <div className={styles.rowMeta}>
          <span className={`${styles.rowMetaItem} ${getStatusTextClass(booking)}`}>
            {getStatusLabel(booking)}
          </span>
          <div className={styles.rowMetaWithIcon}>
            <span className={`material-symbols-outlined ${styles.rowMetaIcon}`}>schedule</span>
            <span className={styles.rowMetaItem}>{timeOrDate}</span>
          </div>
          {displayName && (
            <div className={styles.rowMetaWithIcon}>
              <span className={`material-symbols-outlined ${styles.rowMetaIcon}`}>person</span>
              <span className={styles.rowMetaItem}>{displayName}</span>
            </div>
          )}
          <div className={styles.rowMetaWithIcon}>
            <span className={`material-symbols-outlined ${styles.rowMetaIcon}`}>inventory_2</span>
            <span className={styles.rowMetaItem}>
              {itemCount} {itemCount === 1 ? 'item' : 'items'}
            </span>
          </div>
        </div>
      </div>
      <span className={styles.rowChevron}>›</span>
    </Link>
  )
}

function formatBookingDateTime(
  startDate: string,
  endDate: string,
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): string {
  const months = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']

  const parseDate = (dateStr: string) => {
    const [year, month, day] = dateStr.split('-')
    return { year: parseInt(year), month: parseInt(month) - 1, day: parseInt(day) }
  }

  const formatMonthDay = (dateStr: string): string => {
    const d = parseDate(dateStr)
    return `${d.day} ${months[d.month]}`
  }

  const sameDay = startDate === endDate
  const start = parseDate(startDate)
  const end = parseDate(endDate)
  const sameMonth = start.month === end.month && start.year === end.year
  const hasTime = startTime && endTime

  if (hasTime) {
    if (sameDay) {
      return `${formatMonthDay(startDate)} ${startTime}-${endTime}`
    } else {
      return `${formatMonthDay(startDate)} ${startTime} - ${formatMonthDay(endDate)} ${endTime}`
    }
  } else {
    if (sameDay) {
      return formatMonthDay(startDate)
    } else if (sameMonth) {
      return `${start.day} - ${formatMonthDay(endDate)}`
    } else {
      return `${formatMonthDay(startDate)} - ${formatMonthDay(endDate)}`
    }
  }
}
