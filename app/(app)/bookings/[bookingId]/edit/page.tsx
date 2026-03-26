import { notFound, redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { getBooking } from '@/lib/queries/bookings'
import { getEquipment } from '@/lib/queries/equipment'
import BookingForm from '@/components/bookings/BookingForm'

interface EditBookingPageProps {
  params: Promise<{ bookingId: string }>
}

/**
 * Edit booking page — Server Component.
 * Fetches the booking and equipment list, then renders BookingForm in edit mode.
 * Redirects if the user lacks permission or the booking is not editable.
 */
export default async function EditBookingPage({ params }: EditBookingPageProps) {
  const { bookingId } = await params
  const session = await getVerifiedSession()

  if (session.role === 'viewer') {
    redirect(`/bookings/${bookingId}`)
  }

  const [booking, equipment] = await Promise.all([
    getBooking(session.activeCompanyId, bookingId),
    getEquipment(session.activeCompanyId),
  ])

  if (!booking) notFound()

  const isOwner = booking.userId === session.uid
  const isAdmin = session.role === 'admin'

  if (!isOwner && !isAdmin) {
    redirect(`/bookings/${bookingId}`)
  }

  if (booking.status !== 'pending' && booking.status !== 'confirmed') {
    redirect(`/bookings/${bookingId}`)
  }

  return (
    <BookingForm
      companyId={session.activeCompanyId}
      equipment={equipment}
      defaultStartDate={booking.startDate}
      defaultEndDate={booking.endDate}
      bookingId={bookingId}
      initialProjectName={booking.projectName}
      initialNotes={booking.notes}
      initialItems={booking.items}
    />
  )
}
