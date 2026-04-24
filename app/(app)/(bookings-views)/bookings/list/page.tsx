import { getVerifiedSession } from '@/lib/dal'
import { getBookings } from '@/lib/queries/bookings'
import BookingList from '@/components/bookings/BookingList'

export default async function BookingsListPage() {
  const session = await getVerifiedSession()
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
