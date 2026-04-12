import { getVerifiedSession } from '@/lib/dal'
import { getBookings } from '@/lib/queries/bookings'
import BookingWeekView from '@/components/bookings/BookingWeekView'

/**
 * Week view page — Server Component shell.
 * Passes session data and initial bookings to the BookingWeekView Client Component.
 * The week displayed is controlled by URL search params (?week=11&year=2026).
 */
export default async function BookingsWeekPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; year?: string }>
}) {
  const session = await getVerifiedSession()
  const sp      = await searchParams

  // Determine which week to display
  const now        = new Date()
  const yearParam  = sp.year  ? parseInt(sp.year,  10) : now.getFullYear()
  const weekParam  = sp.week  ? parseInt(sp.week,  10) : getISOWeek(now)

  const { weekStart, weekEnd } = getWeekBounds(yearParam, weekParam)

  const startDateStr = toDateString(weekStart)
  const endDateStr   = toDateString(weekEnd)

  const initialBookings = await getBookings(session.activeCompanyId, {
    startDate: startDateStr,
    endDate:   endDateStr,
  })

  return (
    <BookingWeekView
      companyId={session.activeCompanyId}
      initialBookings={initialBookings}
      weekNumber={weekParam}
      year={yearParam}
      weekStart={startDateStr}
      weekEnd={endDateStr}
    />
  )
}

// ---------------------------------------------------------------------------
// Week calculation helpers
// ---------------------------------------------------------------------------

function getISOWeek(date: Date): number {
  const d     = new Date(date)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7))
  const week1 = new Date(d.getFullYear(), 0, 4)
  return (
    1 +
    Math.round(
      ((d.getTime() - week1.getTime()) / 86400000 -
        3 +
        ((week1.getDay() + 6) % 7)) /
        7,
    )
  )
}

function getWeekBounds(
  year: number,
  week: number,
): { weekStart: Date; weekEnd: Date } {
  // Monday of ISO week
  const jan4      = new Date(year, 0, 4)
  const mondayW1  = new Date(jan4)
  mondayW1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7))

  const weekStart = new Date(mondayW1)
  weekStart.setDate(mondayW1.getDate() + (week - 1) * 7)

  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekStart.getDate() + 6)

  return { weekStart, weekEnd }
}

function toDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
