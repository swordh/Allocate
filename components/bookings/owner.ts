import type { Booking, UserProfile } from '@/types'

/**
 * Who a booking belongs to, as the views label it.
 *
 * `booking.userName` is not stored — `userId` is the reference and the name is
 * resolved at read time — so every view that shows an owner is handed the
 * profile map its server shell fetched. A booking whose owner has been deleted
 * keeps `userId: null` after the GDPR anonymisation and says so.
 */
export function ownerLabel(
  booking: Booking,
  currentUserId: string,
  profiles: Record<string, UserProfile | null>,
): string {
  if (!booking.userId) return 'Deleted user'
  if (booking.userId === currentUserId) return 'You'
  return profiles[booking.userId]?.name || 'Unknown'
}
