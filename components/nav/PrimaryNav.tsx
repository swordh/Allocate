'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { Role } from '@/types'
import styles from './PrimaryNav.module.css'

interface PrimaryNavProps {
  role: Role
}

/**
 * Primary navigation — Client Component.
 * Uses usePathname() for live active-link detection on client-side navigation.
 * Role controls visibility of the Settings link.
 */
export default function PrimaryNav({ role }: PrimaryNavProps) {
  const pathname = usePathname()
  const isActive = (path: string) => pathname.startsWith(path)

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
