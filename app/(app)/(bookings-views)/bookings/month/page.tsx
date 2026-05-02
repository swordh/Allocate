import { getVerifiedSession } from '@/lib/dal'
import { getBookings } from '@/lib/queries/bookings'
import BookingMonthView from '@/components/bookings/BookingMonthView'

/**
 * Month view page — Server Component shell.
 * Passes session data and initial bookings to BookingMonthView Client Component.
 * Month is controlled by URL params (?year=2026&month=4).
 */
export default async function BookingsMonthPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; month?: string }>
}) {
  const session = await getVerifiedSession()
  const sp      = await searchParams

  const now        = new Date()
  const year       = sp.year  ? parseInt(sp.year,  10) : now.getFullYear()
  const month      = sp.month ? parseInt(sp.month, 10) : now.getMonth() + 1

  // Fetch bookings for the full month
  const firstDay = new Date(year, month - 1, 1)
  const lastDay  = new Date(year, month, 0)

  function toDateString(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  const initialBookings = await getBookings(session.activeCompanyId, {
    startDate: toDateString(firstDay),
    endDate:   toDateString(lastDay),
  })

  return (
    <BookingMonthView
      companyId={session.activeCompanyId}
      initialBookings={initialBookings}
      year={year}
      month={month}
    />
  )
}
