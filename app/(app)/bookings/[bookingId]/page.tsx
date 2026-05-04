import { notFound } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { getBooking } from '@/lib/queries/bookings'
import { getEquipment } from '@/lib/queries/equipment'
import { getUserProfile } from '@/lib/queries/users'
import { getCompany } from '@/lib/queries/company'
import BookingDetail from '@/components/bookings/BookingDetail'
import BookingFormPage from '@/components/bookings/BookingFormPage'
import { DEFAULT_COMPANY_PREFERENCES } from '@/constants/company'
import type { UserProfile } from '@/types'

interface BookingDetailPageProps {
  params: Promise<{ bookingId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function BookingDetailPage({ params, searchParams }: BookingDetailPageProps) {
  const { bookingId } = await params
  const sp = await searchParams
  const session = await getVerifiedSession()

  const [booking] = await Promise.all([
    getBooking(session.activeCompanyId, bookingId),
  ])

  if (!booking) notFound()

  const canEdit =
    (booking.userId === session.uid || session.role === 'admin') &&
    (booking.status === 'pending' || booking.status === 'confirmed')

  const wantsEdit = sp['edit'] === '1'
  const isEditing = wantsEdit && canEdit

  if (isEditing) {
    const [company, equipment] = await Promise.all([
      getCompany(session.activeCompanyId),
      // Booking form must only show active equipment so users can't re-book deleted items.
      getEquipment(session.activeCompanyId),
    ])
    const timeSlotMinutes = company?.preferences?.bookingTimeSlotMinutes ?? DEFAULT_COMPANY_PREFERENCES.bookingTimeSlotMinutes

    return (
      <BookingFormPage
        companyId={session.activeCompanyId}
        equipment={equipment}
        defaultStartDate={booking.startDate}
        defaultEndDate={booking.endDate}
        timeSlotMinutes={timeSlotMinutes}
        booking={booking}
        bookingId={booking.id}
      />
    )
  }

  let userProfile: UserProfile | null = null
  if (booking.userId) {
    userProfile = await getUserProfile(booking.userId)
  }

  // Fetch with inactive so deleted equipment/units are still named in the pick list.
  const equipment = await getEquipment(session.activeCompanyId, { includeInactive: true })

  return (
    <BookingDetail
      booking={booking}
      equipment={equipment}
      sessionUid={session.uid}
      role={session.role}
      userProfile={userProfile}
    />
  )
}
