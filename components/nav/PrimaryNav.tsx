import Link from 'next/link'
import type { Role } from '@/types'
import styles from './PrimaryNav.module.css'

interface PrimaryNavProps {
  role: Role
  activePath: string
}

/**
 * Primary navigation — Server Component.
 * Receives role and activePath as serializable props from the app layout.
 * Role controls visibility of the Settings link.
 */
export default function PrimaryNav({ role, activePath }: PrimaryNavProps) {
  const isActive = (path: string) => activePath.startsWith(path)

  return (
    <nav className={styles.nav}>
      <div className={styles.inner}>
        <span className={styles.wordmark}>ALLOCATE</span>

        <div className={styles.links}>
          <Link
            href="/bookings"
            className={`${styles.link} ${isActive('/bookings') ? styles.linkActive : ''}`}
          >
            BOOKINGS
          </Link>
          <Link
            href="/equipment"
            className={`${styles.link} ${isActive('/equipment') ? styles.linkActive : ''}`}
          >
            EQUIPMENT
          </Link>
          {role === 'admin' && (
            <Link
              href="/settings"
              className={`${styles.link} ${isActive('/settings') ? styles.linkActive : ''}`}
            >
              SETTINGS
            </Link>
          )}
        </div>

        <div className={styles.actions}>
          <Link href="/bookings/new" className={styles.newBookingBtn}>
            NEW BOOKING
          </Link>
        </div>
      </div>
    </nav>
  )
}
