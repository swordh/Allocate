'use client'

import { useCallback, useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { Booking } from '@/types'

export interface BookingFilters {
  /** SHOW CANCELLED — feeds `useBookings({ includeCancelled })`. */
  showCancelled: boolean
  /** ONLY MINE — applied in memory against `booking.userId`. */
  onlyMine: boolean
  toggleCancelled: () => void
  toggleOnlyMine: () => void
  /** Current filter state as search params, for links that must preserve it. */
  filterParams: URLSearchParams
}

/**
 * The two view filters live in the URL rather than in component state.
 *
 * Switching view is route navigation, so anything held in `useState` would be
 * thrown away on every LIST → WEEK → MONTH hop — and before phase 4 the three
 * calendar views had no filters at all while the list view kept its own local
 * pair. One source, shared by all four, and a filtered view is now a linkable
 * URL.
 */
export function useBookingFilters(): BookingFilters {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const showCancelled = searchParams.get('cancelled') === '1'
  const onlyMine = searchParams.get('mine') === '1'

  const setParam = useCallback(
    (key: string, on: boolean) => {
      const next = new URLSearchParams(searchParams.toString())
      if (on) next.set(key, '1')
      else next.delete(key)
      const query = next.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [router, pathname, searchParams],
  )

  const filterParams = useMemo(() => {
    const params = new URLSearchParams()
    if (showCancelled) params.set('cancelled', '1')
    if (onlyMine) params.set('mine', '1')
    return params
  }, [showCancelled, onlyMine])

  return {
    showCancelled,
    onlyMine,
    toggleCancelled: () => setParam('cancelled', !showCancelled),
    toggleOnlyMine: () => setParam('mine', !onlyMine),
    filterParams,
  }
}

/** Applies ONLY MINE. SHOW CANCELLED is handled server-side by `useBookings`. */
export function applyOwnerFilter(bookings: Booking[], onlyMine: boolean, userId: string): Booking[] {
  if (!onlyMine) return bookings
  return bookings.filter((b) => b.userId === userId)
}
