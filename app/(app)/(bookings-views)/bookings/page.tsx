import { getVerifiedSession } from '@/lib/dal'
import { getUserProfile } from '@/lib/queries/users'
import { redirect } from 'next/navigation'
import { BOOKING_VIEW_PATHS } from '@/constants/company'
import type { BookingViewOption } from '@/constants/company'

/**
 * Pure router — redirects to the user's preferred default view.
 * The actual list view lives at /bookings/list.
 */
export default async function BookingsRouterPage() {
  const session = await getVerifiedSession()

  const userProfile = await getUserProfile(session.uid)
  const defaultView = (userProfile?.defaultBookingView ?? 'list') as BookingViewOption

  redirect(BOOKING_VIEW_PATHS[defaultView])
}
