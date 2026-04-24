import { getVerifiedSession } from '@/lib/dal'
import { getEquipment } from '@/lib/queries/equipment'
import { getCompany } from '@/lib/queries/company'
import BookingForm from '@/components/bookings/BookingForm'
import { redirect } from 'next/navigation'
import { DEFAULT_COMPANY_PREFERENCES } from '@/constants/company'
import styles from './page.module.css'

export default async function NewBookingPage() {
  const session = await getVerifiedSession()

  if (session.role === 'viewer') {
    redirect('/bookings')
  }

  const today = new Date()
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  const [equipment, company] = await Promise.all([
    getEquipment(session.activeCompanyId),
    getCompany(session.activeCompanyId),
  ])

  const timeSlotMinutes = company?.preferences?.bookingTimeSlotMinutes ?? DEFAULT_COMPANY_PREFERENCES.bookingTimeSlotMinutes

  return (
    <main className={styles.main}>
      <div className={styles.contentWidth}>
        <header className={styles.header}>
          <h1 className={styles.h1}>NEW BOOKING</h1>
          <div className={styles.divider} />
        </header>
        <BookingForm
          companyId={session.activeCompanyId}
          equipment={equipment}
          defaultStartDate={todayStr}
          defaultEndDate={todayStr}
          timeSlotMinutes={timeSlotMinutes}
        />
      </div>
    </main>
  )
}
