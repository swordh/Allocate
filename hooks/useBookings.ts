'use client'

import { useEffect, useState } from 'react'
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  Timestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import type { Booking, BookingStatus, ApprovalStatus, BookingItem } from '@/types'

export interface UseBookingsOptions {
  /** Include cancelled bookings in the result. Defaults to false. */
  includeCancelled?: boolean
  /**
   * Server-side lower bound for endDate "YYYY-MM-DD" (inclusive).
   * Bookings whose endDate is before this value are excluded at the Firestore level.
   * Defaults to 90 days ago to prevent a full collection scan.
   */
  startDate?: string
  /** Upper bound date filter "YYYY-MM-DD" (inclusive). Applied client-side. */
  endDate?: string
}

function docToBooking(id: string, data: Record<string, unknown>): Booking {
  return {
    id,
    projectName:      (data.projectName as string)      ?? '',
    notes:            (data.notes as string)            ?? '',
    items:            (data.items as BookingItem[])     ?? [],
    equipmentIds:     (data.equipmentIds as string[])   ?? [],
    startDate:        (data.startDate as string)        ?? '',
    endDate:          (data.endDate as string)          ?? '',
    userId:           (data.userId as string | null)    ?? null,
    userName:         (data.userName as string)         ?? '',
    status:           (data.status as BookingStatus)    ?? 'pending',
    createdAt:        data.createdAt instanceof Timestamp
                        ? data.createdAt.toDate().toISOString()
                        : ((data.createdAt as string) ?? ''),
    updatedAt:        data.updatedAt instanceof Timestamp
                        ? data.updatedAt.toDate().toISOString()
                        : (data.updatedAt as string | undefined),
    requiresApproval: (data.requiresApproval as boolean)    ?? false,
    approverId:       (data.approverId as string | null)     ?? null,
    approvalStatus:   (data.approvalStatus as ApprovalStatus) ?? 'none',
    rejectionReason:  (data.rejectionReason as string | null) ?? null,
    cancelledAt:      data.cancelledAt instanceof Timestamp
                        ? data.cancelledAt.toDate().toISOString()
                        : ((data.cancelledAt as string | null) ?? null),
    cancelledBy:      (data.cancelledBy as string | null) ?? null,
  }
}

/**
 * Real-time Firestore listener on the company's bookings collection.
 * Always cleans up the listener on unmount or when dependencies change.
 *
 * Bookings are returned ordered by startDate descending.
 * Cancelled bookings are excluded by default.
 */
export function useBookings(
  companyId: string,
  options: UseBookingsOptions = {},
) {
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<Error | null>(null)

  const { includeCancelled = false, startDate, endDate } = options

  useEffect(() => {
    if (!companyId) {
      setLoading(false)
      return
    }

    // Server-side lower bound: use caller-supplied startDate, or default to 90 days
    // ago. This prevents a full collection scan regardless of how many bookings exist.
    // We filter on endDate so that bookings still in progress (started before the
    // window but ending within it) are included.
    const serverLowerBound = startDate ?? (() => {
      const d = new Date()
      d.setDate(d.getDate() - 90)
      return d.toISOString().slice(0, 10)
    })()

    const baseQuery = query(
      collection(db, 'companies', companyId, 'bookings'),
      where('endDate', '>=', serverLowerBound),
      orderBy('endDate', 'asc'),
    )

    const unsubscribe = onSnapshot(
      baseQuery,
      (snapshot) => {
        let docs = snapshot.docs.map((doc) =>
          docToBooking(doc.id, doc.data() as Record<string, unknown>),
        )

        // Client-side filters applied after server-bounded fetch.
        if (!includeCancelled) {
          docs = docs.filter((b) => b.status !== 'cancelled')
        }
        if (endDate) {
          docs = docs.filter((b) => b.endDate <= endDate)
        }

        // Sort by startDate descending for the list view.
        docs.sort((a, b) => (a.startDate > b.startDate ? -1 : 1))

        setBookings(docs)
        setLoading(false)
        setError(null)
      },
      (err) => {
        const code = (err as { code?: string }).code ?? 'unknown'
        console.error('[useBookings] Firestore listener error', { code })
        setError(err)
        setLoading(false)
      },
    )

    return unsubscribe
  }, [companyId, includeCancelled, startDate ?? '', endDate ?? ''])

  return { bookings, loading, error }
}
