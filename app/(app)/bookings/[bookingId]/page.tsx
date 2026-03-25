import { notFound } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { getBooking } from '@/lib/queries/bookings'
import { getEquipment } from '@/lib/queries/equipment'
import BookingDetail from '@/components/bookings/BookingDetail'

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

  return (
    <BookingDetail
      booking={booking}
      equipment={equipment}
      sessionUid={session.uid}
      role={session.role}
    />
  )
}
