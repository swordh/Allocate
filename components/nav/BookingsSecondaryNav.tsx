'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import styles from './BookingsSecondaryNav.module.css'

interface NavItem {
  label: string
  href: string
  disabled?: boolean
}

const ITEMS: NavItem[] = [
  { label: 'List',    href: '/bookings/list' },
  { label: 'Week',    href: '/bookings/week' },
  { label: 'Month',   href: '/bookings/month' },
  { label: '4 Weeks', href: '/bookings/4weeks' },
]

/**
 * Secondary nav for the bookings section.
 * List and Week are active. Month and 4 Weeks are stubs (coming soon).
 */
export default function BookingsSecondaryNav() {
  const pathname = usePathname()

  function isActive(href: string): boolean {
    return pathname === href || pathname.startsWith(href + '/')
  }

  return (
    <nav className={styles.nav}>
      {ITEMS.map((item) => {
        if (item.disabled) {
          return (
            <span key={item.href} className={`${styles.item} ${styles.itemDisabled}`}>
              {item.label}
            </span>
          )
        }

        return (
          <Link
            key={item.href}
            href={item.href}
            className={`${styles.item} ${isActive(item.href) ? styles.itemActive : ''}`}
          >
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
