import { getBookings } from '@/lib/queries/bookings'
import { getBookingViewContext, getOwnerProfiles } from '@/lib/bookings/view-context'
import { getMondayString, offsetDate, parseDateString, toDateString } from '@/lib/dates'
import BookingMonthView from '@/components/bookings/BookingMonthView'

/**
 * Month view page — Server Component shell.
 * The displayed month comes from the URL (?year=2026&month=6); without it,
 * the month containing today in the company's timezone.
 */
export default async function BookingsMonthPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; month?: string; cancelled?: string }>
}) {
  const { companyId, userId, today } = await getBookingViewContext()
  const sp = await searchParams

  const todayDate = parseDateString(today)
  const year = Number.parseInt(sp.year ?? '', 10) || todayDate.getUTCFullYear()
  const month = Number.parseInt(sp.month ?? '', 10) || todayDate.getUTCMonth() + 1

  const firstOfMonth = toDateString(new Date(Date.UTC(year, month - 1, 1)))
  const lastOfMonth = toDateString(new Date(Date.UTC(year, month, 0)))

  // The grid is Monday-first and pads into the neighbouring months, so the
  // window has to cover the padding cells too or their bars go missing.
  const gridStart = getMondayString(firstOfMonth)
  const gridEnd = offsetDate(gridStart, 41)

  const initialBookings = await getBookings(companyId, {
    startDate: gridStart,
    endDate: gridEnd,
    includeCancelled: sp.cancelled === '1',
  })

  return (
    <BookingMonthView
      mode="month"
      companyId={companyId}
      userId={userId}
      today={today}
      initialBookings={initialBookings}
      userProfiles={await getOwnerProfiles(initialBookings)}
      year={year}
      month={month}
      periodStart={firstOfMonth}
      periodEnd={lastOfMonth}
    />
  )
}
