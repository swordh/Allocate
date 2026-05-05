'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { deleteSession } from '@/actions/auth'
import styles from './OperatorTopBar.module.css'

const NAV_LINKS = [
  { label: 'Customers', href: '/operator/customers' },
  { label: 'Feedback',  href: '/operator/feedback'  },
]

interface OperatorTopBarProps {
  onMenuOpen: () => void
}

export default function OperatorTopBar({ onMenuOpen }: OperatorTopBarProps) {
  const pathname = usePathname()

  async function handleLogout() {
    await deleteSession()
    window.location.href = '/login'
  }

  return (
    <nav className={styles.nav}>
      <div className={styles.inner}>
        <span className={styles.wordmark}>Allocate / Operator</span>

        <div className={styles.links}>
          {NAV_LINKS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.link} ${pathname.startsWith(item.href) ? styles.linkActive : ''}`}
            >
              {item.label}
            </Link>
          ))}
        </div>

        <div className={styles.desktopControls}>
          <button className={styles.logoutBtn} onClick={handleLogout}>
            Logout
          </button>
        </div>

        <button
          className={styles.hamburger}
          onClick={onMenuOpen}
          aria-label="Open navigation menu"
        >
          <span className="material-symbols-outlined">menu</span>
        </button>
      </div>
    </nav>
  )
}
