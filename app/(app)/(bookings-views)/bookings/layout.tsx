import Link from 'next/link'
import { PageHeader } from '@/components/nav/PageHeader'
import BookingsSecondaryNav from '@/components/nav/BookingsSecondaryNav'
import styles from './bookings-layout.module.css'

/**
 * Bookings layout — Server Component.
 * Shared across all four booking views: list, week, month, 4weeks.
 * Renders PageHeader with secondary nav as actions.
 * On mobile: secondary nav is hidden (lives in hamburger sheet instead);
 * a "New Booking" button is shown directly under the title.
 */
export default function BookingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.contentWidth}>
      <PageHeader title="BOOKINGS" actions={<BookingsSecondaryNav />} />
      <div className={styles.mobileNewBooking}>
        <Link href="/bookings/new" className={styles.mobileNewBookingBtn}>
          New Booking
        </Link>
      </div>
      {children}
    </div>
  )
}
