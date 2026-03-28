import { PageHeader } from '@/components/nav/PageHeader'
import BookingsSecondaryNav from '@/components/nav/BookingsSecondaryNav'
import styles from './bookings-layout.module.css'

/**
 * Bookings layout — Server Component.
 * Shared across all four booking views: list, week, month, 4weeks.
 * Renders PageHeader with secondary nav as actions.
 */
export default function BookingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.contentWidth}>
      <PageHeader title="BOOKINGS" actions={<BookingsSecondaryNav />} />
      {children}
    </div>
  )
}
