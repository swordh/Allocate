import BookingForm from './BookingForm'
import type { Booking, Equipment } from '@/types'

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
    <BookingForm
      companyId={companyId}
      equipment={equipment}
      defaultStartDate={defaultStartDate}
      defaultEndDate={defaultEndDate}
      timeSlotMinutes={timeSlotMinutes}
      booking={booking}
      bookingId={bookingId}
    />
  )
}
