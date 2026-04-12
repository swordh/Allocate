import { getVerifiedSession } from '@/lib/dal'
import { getBookings } from '@/lib/queries/bookings'
import BookingList from '@/components/bookings/BookingList'

/**
 * Bookings list page — Server Component.
 * Fetches session and initial bookings server-side for first-paint data.
 * BookingList is a Client Component that switches to a real-time listener.
 */
export default async function BookingsListPage() {
  const session         = await getVerifiedSession()
  const initialBookings = await getBookings(session.activeCompanyId)

  return (
    <BookingList
      companyId={session.activeCompanyId}
      userId={session.uid}
      role={session.role}
      initialBookings={initialBookings}
    />
  )
}
