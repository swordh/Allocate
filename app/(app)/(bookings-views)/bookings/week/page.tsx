import { getBookings } from '@/lib/queries/bookings'
import { getBookingViewContext, getOwnerProfiles } from '@/lib/bookings/view-context'
import { getISOWeek, getISOWeekYear, getWeekBounds } from '@/lib/dates'
import BookingWeekView from '@/components/bookings/BookingWeekView'

/**
 * Week view page — Server Component shell.
 * The displayed week comes from the URL (?week=24&year=2026); without it,
 * the week containing today in the company's timezone.
 */
export default async function BookingsWeekPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; year?: string; cancelled?: string }>
}) {
  const { companyId, userId, today } = await getBookingViewContext()
  const sp = await searchParams

  const week = Number.parseInt(sp.week ?? '', 10) || getISOWeek(today)
  const year = Number.parseInt(sp.year ?? '', 10) || getISOWeekYear(today)

  const { weekStart, weekEnd } = getWeekBounds(year, week)

  const initialBookings = await getBookings(companyId, {
    startDate: weekStart,
    endDate: weekEnd,
    includeCancelled: sp.cancelled === '1',
  })

  return (
    <BookingWeekView
      companyId={companyId}
      userId={userId}
      today={today}
      initialBookings={initialBookings}
      userProfiles={await getOwnerProfiles(initialBookings)}
      weekNumber={week}
      year={year}
      weekStart={weekStart}
      weekEnd={weekEnd}
    />
  )
}
