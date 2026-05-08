'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { Role } from '@/types'
import { useSupportContext } from '@/lib/support-context'
import styles from './PrimaryNav.module.css'

const ENV_LABELS: Record<string, string> = {
  dev:   'Dev',
  alpha: 'Alpha',
  beta:  'Beta',
}

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
  const { openHelp, openNotifications, notificationsOpen, unreadCount } = useSupportContext()

  return (
    <nav className={styles.nav}>
      <div className={styles.inner}>
        <div className={styles.wordmarkGroup}>
          <span className={styles.wordmark}>ALLOCATE</span>
          {process.env.NEXT_PUBLIC_APP_ENV && ENV_LABELS[process.env.NEXT_PUBLIC_APP_ENV] && (
            <span className={`${styles.envBadge} ${styles[`envBadge_${process.env.NEXT_PUBLIC_APP_ENV}`]}`}>
              {ENV_LABELS[process.env.NEXT_PUBLIC_APP_ENV]}
            </span>
          )}
        </div>

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
          <Link
            href="/settings"
            className={`${styles.link} ${isActive('/settings') ? styles.linkActive : ''}`}
          >
            SETTINGS
          </Link>
        </div>

        <div className={styles.actions}>
          <div className={styles.iconGroup}>
            <button
              className={`${styles.iconBtn} ${notificationsOpen ? styles.iconBtnActive : ''}`}
              onClick={openNotifications}
              aria-label="Notifications"
              title="Notifications"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>notifications</span>
              {unreadCount > 0 && <span className={styles.unreadDot} aria-hidden="true" />}
            </button>
            <button
              className={styles.iconBtn}
              onClick={() => openHelp()}
              aria-label="Help & feedback"
              title="Help & feedback  (Shift+?)"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>help</span>
            </button>
          </div>

          {isActive('/equipment') && role === 'admin' ? (
            <Link href="/equipment?add=1" className={styles.newBookingBtn}>
              NEW EQUIPMENT
            </Link>
          ) : (
            <Link href="/bookings/new" className={styles.newBookingBtn}>
              NEW BOOKING
            </Link>
          )}
        </div>
      </div>
    </nav>
  )
}
