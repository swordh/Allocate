import 'server-only'

import { getVerifiedSession } from '@/lib/dal'
import { getCompany } from '@/lib/queries/company'
import { getUserProfile } from '@/lib/queries/users'
import { DEFAULT_COMPANY_PREFERENCES } from '@/constants/company'
import { todayInTimezone } from '@/lib/dates'
import type { Booking, Role, UserProfile } from '@/types'

export interface BookingViewContext {
  companyId: string
  userId: string
  role: Role
  /** CompanyPreferences.timezone — every date and time in the views renders in it. */
  timezone: string
  /** Today's civil date in that zone. Decides which cell is highlighted. */
  today: string
}

/**
 * The four booking view shells all need the same four things. `getCompany` and
 * `getVerifiedSession` are both React-cached, so calling this once per page
 * costs one read no matter how many callers there are in a render pass.
 */
export async function getBookingViewContext(): Promise<BookingViewContext> {
  const session = await getVerifiedSession()
  const company = await getCompany(session.activeCompanyId)
  const timezone = company?.preferences?.timezone ?? DEFAULT_COMPANY_PREFERENCES.timezone

  return {
    companyId: session.activeCompanyId,
    userId: session.uid,
    role: session.role,
    timezone,
    today: todayInTimezone(timezone),
  }
}

/**
 * Owner names for a set of bookings, keyed by userId.
 *
 * `Booking.userName` is not stored, so every view that labels an owner needs
 * this. `getUserProfile` is React-cached, and the lookups run in parallel — the
 * list view used to await them one after another.
 */
export async function getOwnerProfiles(
  bookings: Booking[],
): Promise<Record<string, UserProfile | null>> {
  const ids = Array.from(
    new Set(bookings.map((b) => b.userId).filter((id): id is string => !!id)),
  )
  const profiles = await Promise.all(ids.map((id) => getUserProfile(id)))

  const map: Record<string, UserProfile | null> = {}
  ids.forEach((id, i) => { map[id] = profiles[i] })
  return map
}
