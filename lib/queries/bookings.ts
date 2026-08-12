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
    unitIds:         data.unitIds         ?? [],
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
  /** Window start "YYYY-MM-DD", inclusive. */
  startDate?: string
  /** Window end "YYYY-MM-DD", inclusive. */
  endDate?: string
}

/**
 * One-shot fetch of bookings for a company, ordered by startDate descending.
 * Cancelled bookings are excluded by default.
 *
 * `startDate`/`endDate` describe a window the booking must **overlap**, not one
 * it must fit inside. Until phase 4 this filtered on `startDate >= from` and
 * `endDate <= to`, which silently dropped every booking that straddled the edge
 * of the window — precisely the multi-week blocks the week and month grids have
 * to draw clipped at their boundary.
 *
 * Only `endDate` is bounded server-side (one range field, so the existing
 * single-field index covers it); the start edge is trimmed in memory. That is
 * the same shape `hooks/useBookings.ts` uses for the live listener, so the SSR
 * seed and the first snapshot agree.
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

  if (options.startDate) {
    // A booking overlaps the window if it has not already ended before it.
    query = query.where('endDate', '>=', options.startDate).orderBy('endDate', 'asc')
  } else {
    query = query.orderBy('startDate', 'desc')
  }

  const snapshot = await query.get()
  let bookings = snapshot.docs.map(docToBooking)

  if (options.endDate) {
    // …and if it has already begun by the time the window closes.
    bookings = bookings.filter((b) => b.startDate <= options.endDate!)
  }

  if (!options.includeCancelled) {
    bookings = bookings.filter((b) => b.status !== 'cancelled')
  }

  return bookings.sort((a, b) => b.startDate.localeCompare(a.startDate))
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
