'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { deleteSession } from '@/actions/auth'
import styles from './OperatorMobileMenu.module.css'

const NAV_ITEMS = [
  { label: 'Customers', href: '/operator/customers' },
  { label: 'Feedback',  href: '/operator/feedback'  },
]

interface OperatorMobileMenuProps {
  open: boolean
  onClose: () => void
}

export default function OperatorMobileMenu({ open, onClose }: OperatorMobileMenuProps) {
  const pathname = usePathname()

  // Auto-close when the route changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { onClose() }, [pathname])

  // Prevent body scroll while sheet is open
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  function isActive(href: string) {
    return pathname.startsWith(href)
  }

  async function handleLogout() {
    await deleteSession()
    window.location.href = '/login'
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className={`${styles.backdrop} ${open ? styles.backdropOpen : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet */}
      <div
        className={`${styles.sheet} ${open ? styles.sheetOpen : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
      >
        <div className={styles.sheetHeader}>
          <button
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close navigation menu"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className={styles.sheetBody}>
          <div className={styles.section}>
            <p className={styles.sectionLabel}>Navigate</p>
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`${styles.navItem} ${isActive(item.href) ? styles.navItemActive : ''}`}
              >
                {item.label}
              </Link>
            ))}
          </div>
        </div>

        <div className={styles.sheetFooter}>
          <button className={styles.ctaBtn} onClick={handleLogout}>
            Logout
          </button>
        </div>
      </div>
    </>
  )
}
