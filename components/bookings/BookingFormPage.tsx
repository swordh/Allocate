import BookingForm from './BookingForm'
import { PageHeader } from '@/components/nav/PageHeader'
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
    <>
      <PageHeader title="BOOKING" />
      <div className={styles.contentWidth}>
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
    </>
  )
}
