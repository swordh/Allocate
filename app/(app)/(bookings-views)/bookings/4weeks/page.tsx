import { getVerifiedSession } from '@/lib/dal'
import { getBookings } from '@/lib/queries/bookings'
import Booking4WeekView from '@/components/bookings/Booking4WeekView'

/**
 * 4-Week view page — Server Component shell.
 * Passes session data and initial bookings to Booking4WeekView Client Component.
 * Period is controlled by URL param (?start=YYYY-MM-DD — must be a Monday).
 */
export default async function Bookings4WeeksPage({
  searchParams,
}: {
  searchParams: Promise<{ start?: string }>
}) {
  const session = await getVerifiedSession()
  const sp      = await searchParams

  // Default to the Monday of the current week
  const periodStart = sp.start ?? getMondayString(new Date())

  // Fetch bookings for the 28-day window
  const endDate = offsetDate(periodStart, 27)

  const initialBookings = await getBookings(session.activeCompanyId, {
    startDate: periodStart,
    endDate,
  })

  return (
    <Booking4WeekView
      companyId={session.activeCompanyId}
      initialBookings={initialBookings}
      periodStart={periodStart}
    />
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Returns the Monday of the ISO week containing the given date. */
function getMondayString(date: Date): string {
  const d   = new Date(date)
  const day = (d.getDay() + 6) % 7  // Mon=0 … Sun=6
  d.setDate(d.getDate() - day)
  return toDateString(d)
}

/** Returns the date string N days after the given date string. */
function offsetDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return toDateString(d)
}
