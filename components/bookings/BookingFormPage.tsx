import BookingForm from './BookingForm'
import type { Booking, Equipment } from '@/types'
import styles from './BookingFormPage.module.css'

interface BookingFormPageProps {
  companyId: string
  equipment: Equipment[]
  defaultStartDate: string
  defaultEndDate: string
  timeSlotMinutes: number
  booking?: Booking
  bookingId?: string
}

export default function BookingFormPage({
  companyId,
  equipment,
  defaultStartDate,
  defaultEndDate,
  timeSlotMinutes,
  booking,
  bookingId,
}: BookingFormPageProps) {
  return (
    <main className={styles.main}>
      <div className={styles.contentWidth}>
        <header className={styles.header}>
          <h1 className={styles.h1}>BOOKING</h1>
          <div className={styles.divider} />
        </header>
        <BookingForm
          companyId={companyId}
          equipment={equipment}
          defaultStartDate={defaultStartDate}
          defaultEndDate={defaultEndDate}
          timeSlotMinutes={timeSlotMinutes}
          booking={booking}
          bookingId={bookingId}
        />
      </div>
    </main>
  )
}
