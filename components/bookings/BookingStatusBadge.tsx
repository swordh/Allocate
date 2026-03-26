import type { BookingStatus, ApprovalStatus } from '@/types'
import styles from './BookingStatusBadge.module.css'

interface BookingStatusBadgeProps {
  status: BookingStatus
  approvalStatus?: ApprovalStatus
}

/**
 * Renders a status badge for a booking.
 *
 * When status is 'pending' and approvalStatus is 'rejected', the badge
 * shows "Rejected" rather than "Pending" — per the ADR, rejected bookings
 * keep status=pending but approvalStatus=rejected.
 */
export default function BookingStatusBadge({
  status,
  approvalStatus,
}: BookingStatusBadgeProps) {
  const isRejected = status === 'pending' && approvalStatus === 'rejected'

  const label = isRejected
    ? 'Rejected'
    : STATUS_LABELS[status]

  const className = isRejected
    ? styles.rejected
    : styles[status] ?? styles.pending

  return (
    <span className={`${styles.badge} ${className}`}>
      {label}
    </span>
  )
}

const STATUS_LABELS: Record<BookingStatus, string> = {
  pending:     'Pending',
  confirmed:   'Confirmed',
  checked_out: 'Checked Out',
  returned:    'Returned',
  cancelled:   'Cancelled',
}
