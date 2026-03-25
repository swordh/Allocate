import { getVerifiedSession } from '@/lib/dal'
import { getEquipment } from '@/lib/queries/equipment'
import BookingForm from '@/components/bookings/BookingForm'
import { redirect } from 'next/navigation'

/**
 * New booking page — Server Component shell.
 * Fetches session, verifies the user can create bookings, then passes
 * equipment list to the BookingForm Client Component.
 */
export default async function NewBookingPage() {
  const session = await getVerifiedSession()

  if (session.role === 'viewer') {
    redirect('/bookings')
  }

  const today = new Date()
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  const equipment = await getEquipment(session.activeCompanyId)

  return (
    <BookingForm
      companyId={session.activeCompanyId}
      equipment={equipment}
      defaultStartDate={todayStr}
      defaultEndDate={todayStr}
    />
  )
}
