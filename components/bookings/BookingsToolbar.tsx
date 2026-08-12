'use client'

import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'
import SegmentedControl from '@/components/ui/SegmentedControl'
import Chip from '@/components/ui/Chip'
import Glyph from '@/components/ui/Glyph'
import StatusDot from '@/components/ui/StatusDot'
import { useBookingFilters } from '@/hooks/useBookingFilters'
import styles from './BookingsToolbar.module.css'

export type BookingView = 'list' | 'week' | 'month' | '4weeks'

const SEGMENTS = [
  { value: 'list' as const, label: 'LIST' },
  { value: 'week' as const, label: 'WEEK' },
  { value: 'month' as const, label: 'MONTH' },
  { value: '4weeks' as const, label: '4 WEEKS' },
]

interface BookingsToolbarProps {
  view: BookingView
  /** "8 – 14 JUN 2026" or "JUNE 2026". */
  label: string
  count: number
  /** Omitted by the list view, which has no period to step through. */
  onPrev?: () => void
  onNext?: () => void
  onToday: () => void
  /** The week view's clickable W-number badge with its date popover. */
  badge?: ReactNode
  /** COMPACT LIST, which only the list view has. */
  extraFilters?: ReactNode
}

/**
 * The row shared by all four booking views: view switcher, period stepper,
 * filters and TODAY.
 *
 * NEW BOOKING is deliberately absent — it lives in PrimaryNav on every screen
 * since phase 2, and the design draws it there, not here. Mobile gets it as a
 * floating action button from the bookings layout instead.
 */
export default function BookingsToolbar({
  view,
  label,
  count,
  onPrev,
  onNext,
  onToday,
  badge,
  extraFilters,
}: BookingsToolbarProps) {
  const router = useRouter()
  const { showCancelled, onlyMine, toggleCancelled, toggleOnlyMine, filterParams } = useBookingFilters()

  function switchView(next: BookingView) {
    // Period params (?week, ?month, ?start) are view-specific and do not
    // translate; the filters do and are carried across.
    const query = filterParams.toString()
    router.push(query ? `/bookings/${next}?${query}` : `/bookings/${next}`)
  }

  const countLabel = `${count} ${count === 1 ? 'BOOKING' : 'BOOKINGS'}`

  return (
    <div className={styles.toolbar}>
      <SegmentedControl
        segments={SEGMENTS}
        value={view}
        onChange={switchView}
        ariaLabel="Booking view"
        className={styles.switcher}
      />

      {onPrev && onNext && (
        <div className={styles.stepper}>
          <button type="button" className={styles.stepBtn} onClick={onPrev} aria-label="Previous period">
            <Glyph char="‹" />
          </button>
          <button type="button" className={styles.stepBtn} onClick={onNext} aria-label="Next period">
            <Glyph char="›" />
          </button>
        </div>
      )}

      {badge}

      <span className={styles.periodLabel}>{label}</span>
      <span className={styles.count}>· {countLabel}</span>

      <span className={styles.spacer} />

      <div className={styles.filters}>
        {extraFilters}
        <Chip
          className={styles.filter}
          active={showCancelled}
          onClick={toggleCancelled}
        >
          SHOW CANCELLED
        </Chip>
        <Chip
          className={styles.filter}
          active={onlyMine}
          onClick={toggleOnlyMine}
        >
          ONLY MINE
        </Chip>
      </div>

      <button type="button" className={styles.today} onClick={onToday}>
        <StatusDot size={6} />
        TODAY
      </button>
    </div>
  )
}
