import { getBookings } from '@/lib/queries/bookings'
import { getBookingViewContext, getOwnerProfiles } from '@/lib/bookings/view-context'
import { getMondayString, offsetDate } from '@/lib/dates'
import BookingMonthView from '@/components/bookings/BookingMonthView'

/**
 * 4-week view page — Server Component shell.
 *
 * 4 WEEKS is the month view with a shifted window: four week rows starting at
 * the current week's Monday, same bars, same cells, same mobile agenda
 * (decision 6). There is no separate design for it and none is to be made.
 * Period comes from ?start=YYYY-MM-DD, snapped to a Monday.
 */
export default async function Bookings4WeeksPage({
  searchParams,
}: {
  searchParams: Promise<{ start?: string; cancelled?: string }>
}) {
  const { companyId, userId, today } = await getBookingViewContext()
  const sp = await searchParams

  const periodStart = getMondayString(sp.start ?? today)
  const periodEnd = offsetDate(periodStart, 27)

  const initialBookings = await getBookings(companyId, {
    startDate: periodStart,
    endDate: periodEnd,
    includeCancelled: sp.cancelled === '1',
  })

  return (
    <BookingMonthView
      mode="4weeks"
      companyId={companyId}
      userId={userId}
      today={today}
      initialBookings={initialBookings}
      userProfiles={await getOwnerProfiles(initialBookings)}
      periodStart={periodStart}
      periodEnd={periodEnd}
    />
  )
}
