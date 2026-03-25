'use server'

// Full implementation in Phase 3.
// Stubs are in place so imports don't break and the file structure matches the architecture.

import { getVerifiedSession } from '@/lib/dal'
import type { BookingStatus } from '@/types'

export async function createBooking(_formData: FormData): Promise<{ id: string } | { error: string }> {
  const session = await getVerifiedSession()
  if (session.role === 'viewer') return { error: 'Unauthorized' }
  console.log('[actions/bookings]', { uid: session.uid, action: 'create_booking_stub' })
  return { error: 'Not implemented — Phase 3' }
}

export async function updateBooking(
  _bookingId: string,
  _formData: FormData,
): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role === 'viewer') return { error: 'Unauthorized' }
  console.log('[actions/bookings]', { uid: session.uid, action: 'update_booking_stub' })
  return { error: 'Not implemented — Phase 3' }
}

export async function deleteBooking(_bookingId: string): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role === 'viewer') return { error: 'Unauthorized' }
  console.log('[actions/bookings]', { uid: session.uid, action: 'delete_booking_stub' })
  return { error: 'Not implemented — Phase 3' }
}

export async function updateBookingStatus(
  _bookingId: string,
  _status: BookingStatus,
): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role === 'viewer') return { error: 'Unauthorized' }
  console.log('[actions/bookings]', { uid: session.uid, action: 'update_booking_status_stub' })
  return { error: 'Not implemented — Phase 3' }
}
