import 'server-only'

import { cache } from 'react'
import { adminDb } from '@/lib/firebase-admin'
import type { Booking } from '@/types'

function docToBooking(doc: FirebaseFirestore.DocumentSnapshot): Booking {
  const data = doc.data() ?? {}
  return {
    id: doc.id,
    projectName:     data.projectName     ?? '',
    notes:           data.notes           ?? '',
    items:           data.items           ?? [],
    equipmentIds:    data.equipmentIds    ?? [],
    startDate:       data.startDate       ?? '',
    endDate:         data.endDate         ?? '',
    startTime:       data.startTime       ?? null,
    endTime:         data.endTime         ?? null,
    userId:          data.userId          ?? null,
    userName:        data.userName        ?? '',
    status:          data.status          ?? 'pending',
    createdAt:       data.createdAt?.toDate?.()?.toISOString() ?? data.createdAt ?? '',
    updatedAt:       data.updatedAt?.toDate?.()?.toISOString() ?? data.updatedAt ?? undefined,
    requiresApproval: data.requiresApproval ?? false,
    approverId:      data.approverId      ?? null,
    approvalStatus:  data.approvalStatus  ?? 'none',
    rejectionReason: data.rejectionReason ?? null,
    cancelledAt:     data.cancelledAt?.toDate?.()?.toISOString() ?? data.cancelledAt ?? null,
    cancelledBy:     data.cancelledBy     ?? null,
  } as Booking
}

export interface GetBookingsOptions {
  includeCancelled?: boolean
  startDate?: string  // "YYYY-MM-DD" lower bound (inclusive)
  endDate?: string    // "YYYY-MM-DD" upper bound (inclusive)
}

/**
 * One-shot fetch of bookings for a company.
 * Ordered by startDate descending (most recent first).
 * Cancelled bookings are excluded by default.
 *
 * Wrapped in React.cache so multiple Server Components calling this in the
 * same render pass share one Firestore read.
 */
export const getBookings = cache(async (
  companyId: string,
  options: GetBookingsOptions = {},
): Promise<Booking[]> => {
  let query: FirebaseFirestore.Query = adminDb
    .collection('companies')
    .doc(companyId)
    .collection('bookings')
    .orderBy('startDate', 'desc')

  if (options.startDate) {
    query = query.where('startDate', '>=', options.startDate)
  }
  if (options.endDate) {
    query = query.where('endDate', '<=', options.endDate)
  }

  const snapshot = await query.get()
  const bookings = snapshot.docs.map(docToBooking)

  if (!options.includeCancelled) {
    return bookings.filter((b) => b.status !== 'cancelled')
  }

  return bookings
})

/**
 * Fetch a single booking document by ID.
 */
export const getBooking = cache(async (
  companyId: string,
  bookingId: string,
): Promise<Booking | null> => {
  const doc = await adminDb
    .collection('companies')
    .doc(companyId)
    .collection('bookings')
    .doc(bookingId)
    .get()

  if (!doc.exists) return null
  return docToBooking(doc)
})
