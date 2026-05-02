import { getVerifiedSession } from '@/lib/dal'
import { getBookings } from '@/lib/queries/bookings'
import { getUserProfile } from '@/lib/queries/users'
import BookingList from '@/components/bookings/BookingList'
import type { UserProfile } from '@/types'

export default async function BookingsListPage() {
  const session = await getVerifiedSession()
  const initialBookings = await getBookings(session.activeCompanyId)

  // Fetch UserProfile for each unique userId in the bookings
  const uniqueUserIds = Array.from(new Set(initialBookings.map(b => b.userId).filter((id): id is string => id !== null && id !== undefined)))
  const userProfilesArray = await Promise.all(
    uniqueUserIds.map(uid => getUserProfile(uid)),
  )

  const userProfiles: Record<string, UserProfile | null> = {}
  uniqueUserIds.forEach((uid, idx) => {
    userProfiles[uid] = userProfilesArray[idx]
  })

  return (
    <BookingList
      companyId={session.activeCompanyId}
      userId={session.uid}
      role={session.role}
      initialBookings={initialBookings}
      userProfiles={userProfiles}
    />
  )
}
