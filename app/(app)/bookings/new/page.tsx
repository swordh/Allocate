import { redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { getEquipment } from '@/lib/queries/equipment'
import { getCompany } from '@/lib/queries/company'
import BookingForm from '@/components/bookings/BookingForm'
import { DEFAULT_COMPANY_PREFERENCES } from '@/constants/company'
import { todayInTimezone } from '@/lib/dates'

export default async function NewBookingPage() {
  const session = await getVerifiedSession()

  if (session.role === 'viewer') {
    redirect('/bookings')
  }

  const [equipment, company] = await Promise.all([
    getEquipment(session.activeCompanyId),
    getCompany(session.activeCompanyId),
  ])

  const preferences = company?.preferences
  const timezone = preferences?.timezone ?? DEFAULT_COMPANY_PREFERENCES.timezone
  const today = todayInTimezone(timezone)

  return (
    <BookingForm
      companyId={session.activeCompanyId}
      equipment={equipment}
      defaultStartDate={today}
      defaultEndDate={today}
      timeSlotMinutes={
        preferences?.bookingTimeSlotMinutes ?? DEFAULT_COMPANY_PREFERENCES.bookingTimeSlotMinutes
      }
      timezone={timezone}
    />
  )
}
