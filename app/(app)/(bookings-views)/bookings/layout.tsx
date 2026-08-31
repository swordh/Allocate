import Link from 'next/link'
import Icon from '@/components/ui/Icon'
import styles from './bookings-layout.module.css'

/**
 * Bookings layout — Server Component, shared by list, week, month and 4weeks.
 *
 * The design puts no page title on the view screens: the app header is followed
 * straight by the toolbar, which each view renders itself (it needs the period
 * label and the stepper handlers). So this layout carries only the mobile
 * floating action button — NEW BOOKING sits in PrimaryNav on desktop.
 */
export default function BookingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <Link href="/bookings/new" className={styles.fab}>
        <Icon name="add" size={16} strokeWidth={2.4} aria-hidden />
        NEW BOOKING
      </Link>
    </>
  )
}
