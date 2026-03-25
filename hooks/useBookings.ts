'use client'

import { useEffect, useState } from 'react'
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  Timestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import type { Booking, BookingStatus, ApprovalStatus, BookingItem } from '@/types'

export interface UseBookingsOptions {
  /** Include cancelled bookings in the result. Defaults to false. */
  includeCancelled?: boolean
  /** Lower bound date filter "YYYY-MM-DD" (inclusive). Optional. */
  startDate?: string
  /** Upper bound date filter "YYYY-MM-DD" (inclusive). Optional. */
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

    const baseQuery = query(
      collection(db, 'companies', companyId, 'bookings'),
      orderBy('startDate', 'desc'),
    )

    const unsubscribe = onSnapshot(
      baseQuery,
      (snapshot) => {
        let docs = snapshot.docs.map((doc) =>
          docToBooking(doc.id, doc.data() as Record<string, unknown>),
        )

        // Client-side filters applied after fetch
        if (!includeCancelled) {
          docs = docs.filter((b) => b.status !== 'cancelled')
        }
        if (startDate) {
          docs = docs.filter((b) => b.startDate >= startDate)
        }
        if (endDate) {
          docs = docs.filter((b) => b.endDate <= endDate)
        }

        setBookings(docs)
        setLoading(false)
        setError(null)
      },
      (err) => {
        console.error('[useBookings] Firestore listener error:', err)
        setError(err)
        setLoading(false)
      },
    )

    return unsubscribe
  }, [companyId, includeCancelled, startDate ?? '', endDate ?? ''])

  return { bookings, loading, error }
}
