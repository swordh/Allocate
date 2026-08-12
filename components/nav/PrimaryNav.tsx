'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { Role } from '@/types'
import { useSupportContext } from '@/lib/support-context'
import Button from '@/components/ui/Button'
import { TOP_NAV } from './nav-items'
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
 * The nav itself is the same for every role — Settings is always visible.
 */
export default function PrimaryNav({ role }: PrimaryNavProps) {
  const pathname = usePathname()
  const isActive = (path: string) => pathname.startsWith(path)
  const { openHelp } = useSupportContext()

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
          {TOP_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.link} ${isActive(item.href) ? styles.linkActive : ''}`}
            >
              {item.label}
            </Link>
          ))}
        </div>

        <div className={styles.actions}>
          <div className={styles.iconGroup}>
            <button
              className={styles.helpBtn}
              onClick={() => openHelp()}
              aria-label="Help & feedback"
              title="Help & feedback  (Shift+?)"
            >
              ?
            </button>
          </div>

          {/* NEW BOOKING on every screen, per the design. The equipment page
              carries its own NEW EQUIPMENT button in the page header — this bar
              used to swap to it there, which put two identical buttons on top
              of each other. */}
          <Button variant="primary" size="sm" href="/bookings/new">
            NEW BOOKING
          </Button>
        </div>
      </div>
    </nav>
  )
}
