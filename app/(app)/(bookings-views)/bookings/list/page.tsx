import { getBookings } from '@/lib/queries/bookings'
import { getBookingViewContext, getOwnerProfiles } from '@/lib/bookings/view-context'
import { offsetDate } from '@/lib/dates'
import BookingList from '@/components/bookings/BookingList'

/** How far back the feed reaches. Forward is unbounded. */
const HISTORY_DAYS = 90

export default async function BookingsListPage({
  searchParams,
}: {
  searchParams: Promise<{ cancelled?: string }>
}) {
  const { companyId, userId, role, today } = await getBookingViewContext()
  const sp = await searchParams

  // The feed used to fetch the entire collection unbounded, which grew without
  // limit for any company that had been running a while.
  const initialBookings = await getBookings(companyId, {
    startDate: offsetDate(today, -HISTORY_DAYS),
    includeCancelled: sp.cancelled === '1',
  })

  return (
    <BookingList
      companyId={companyId}
      userId={userId}
      role={role}
      today={today}
      historyStart={offsetDate(today, -HISTORY_DAYS)}
      initialBookings={initialBookings}
      userProfiles={await getOwnerProfiles(initialBookings)}
    />
  )
}
