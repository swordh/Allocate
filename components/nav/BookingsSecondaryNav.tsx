'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BOOKINGS_ITEMS } from './nav-items'
import styles from './BookingsSecondaryNav.module.css'

/**
 * Secondary nav for the bookings section.
 */
export default function BookingsSecondaryNav() {
  const pathname = usePathname()

  function isActive(href: string): boolean {
    return pathname === href || pathname.startsWith(href + '/')
  }

  return (
    <nav className={styles.nav}>
      {BOOKINGS_ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`${styles.item} ${isActive(item.href) ? styles.itemActive : ''}`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  )
}
