'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { useBookings } from '@/hooks/useBookings'
import BookingStatusBadge from './BookingStatusBadge'
import type { Booking, Role } from '@/types'
import styles from './BookingList.module.css'

interface BookingListProps {
  companyId: string
  userId: string
  role: Role
  /** Bookings pre-fetched on the server for initial paint. */
  initialBookings: Booking[]
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
  // Format as "Mon 23 Mar" style
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

function formatFullDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).toUpperCase()
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
  role,
  initialBookings,
}: BookingListProps) {
  const [showCancelled, setShowCancelled] = useState(false)

  const { bookings: liveBookings, loading, error } = useBookings(companyId, {
    includeCancelled: showCancelled,
  })

  // Use live data once the listener has fired; fall back to server-fetched initial data.
  const bookings = loading ? initialBookings : liveBookings

  // Crew only see their own bookings.
  const visibleBookings = useMemo(() => {
    if (role === 'crew') {
      return bookings.filter((b) => b.userId === userId)
    }
    return bookings
  }, [bookings, role, userId])

  const today    = toLocalDateString(new Date())
  const tomorrow = toLocalDateString(new Date(Date.now() + 86400000))

  // Stats are computed but stats bar is commented out per spec
  const stats = useMemo(() => computeStats(visibleBookings, today), [visibleBookings, today])
  void stats // prevent unused variable warning

  // Group non-cancelled bookings by startDate, sorted newest first.
  const grouped = useMemo(() => {
    const all = showCancelled
      ? visibleBookings
      : visibleBookings.filter((b) => b.status !== 'cancelled')
    return groupBookingsByDate(all)
  }, [visibleBookings, showCancelled])

  const sortedDates = useMemo(
    () => Array.from(grouped.keys()).sort((a, b) => (a > b ? -1 : 1)),
    [grouped],
  )

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
      {/* <div className={styles.statsBar}>
        <div className={styles.stat}>
          <span className={styles.statValue}>{stats.bookingsToday}</span>
          <span className={styles.statLabel}>Bookings today</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{stats.itemsOut}</span>
          <span className={styles.statLabel}>Items out</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{stats.pendingApprovals}</span>
          <span className={styles.statLabel}>Pending approvals</span>
        </div>
      </div> */}

      {/* Controls */}
      <div className={styles.controls}>
        <button
          className={`${styles.toggleBtn} ${showCancelled ? styles.toggleActive : ''}`}
          onClick={() => setShowCancelled((v) => !v)}
        >
          {showCancelled ? 'Hide cancelled' : 'Show cancelled'}
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

      {/* Date groups */}
      {sortedDates.map((dateStr) => {
        const dateBookings = grouped.get(dateStr) ?? []
        const label = formatDateLabel(dateStr, today, tomorrow)
        const isToday = dateStr === today
        const fullDate = formatFullDate(dateStr)

        return (
          <div key={dateStr} className={styles.group}>
            <div className={styles.groupHeader}>
              <span className={`${styles.dateLabel} ${isToday ? styles.dateLabelToday : ''}`}>
                {label.toUpperCase()}
              </span>
              <div className={styles.groupRule} />
              <span className={styles.groupDate}>{fullDate}</span>
            </div>
            <div className={styles.bookingCards}>
              {dateBookings.map((booking) => (
                <BookingRow key={booking.id} booking={booking} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Booking row
// ---------------------------------------------------------------------------

function getStatusRowClass(booking: Booking): string {
  switch (booking.status) {
    case 'checked_out': return styles.rowCheckedOut
    case 'confirmed':   return styles.rowConfirmed
    case 'pending':
      // Show rejected style if approval was rejected
      return booking.approvalStatus === 'rejected' ? styles.rowRejected : styles.rowPending
    case 'cancelled':   return styles.rowCancelled
    default:            return styles.rowPending
  }
}

function BookingRow({ booking }: { booking: Booking }) {
  const isCancelled = booking.status === 'cancelled'
  const itemCount   = booking.items.reduce((sum, i) => sum + i.quantity, 0)
  const statusClass = getStatusRowClass(booking)

  return (
    <Link
      href={`/bookings/${booking.id}`}
      className={`${styles.row} ${statusClass} ${isCancelled ? styles.rowCancelled : ''}`}
    >
      <div className={styles.rowLeft}>
        <span className={styles.rowProject}>{booking.projectName}</span>
        <span className={styles.rowDate}>
          {booking.startDate === booking.endDate
            ? formatShortDate(booking.startDate)
            : `${formatShortDate(booking.startDate)} – ${formatShortDate(booking.endDate)}`}
        </span>
      </div>
      <div className={styles.rowMeta}>
        <span className={styles.rowItemCount}>
          {itemCount} {itemCount === 1 ? 'item' : 'items'}
        </span>
        <BookingStatusBadge
          status={booking.status}
          approvalStatus={booking.approvalStatus}
        />
      </div>
    </Link>
  )
}

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  })
}
