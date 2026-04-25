import { notFound } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { getBooking } from '@/lib/queries/bookings'
import { getEquipment } from '@/lib/queries/equipment'
import { getUserProfile } from '@/lib/queries/users'
import BookingDetail from '@/components/bookings/BookingDetail'
import type { UserProfile } from '@/types'

interface BookingDetailPageProps {
  params: Promise<{ bookingId: string }>
}

/**
 * Booking detail page — Server Component.
 * Fetches booking + active equipment in parallel.
 * Not found → 404.
 */
export default async function BookingDetailPage({ params }: BookingDetailPageProps) {
  const { bookingId } = await params
  const session = await getVerifiedSession()

  const [booking, equipment] = await Promise.all([
    getBooking(session.activeCompanyId, bookingId),
    getEquipment(session.activeCompanyId),
  ])

  if (!booking) notFound()

  // Fetch UserProfile for this booking
  let userProfile: UserProfile | null = null
  if (booking.userId) {
    userProfile = await getUserProfile(booking.userId)
  }

  return (
    <BookingDetail
      booking={booking}
      equipment={equipment}
      sessionUid={session.uid}
      role={session.role}
      userProfile={userProfile}
    />
  )
}
