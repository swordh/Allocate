'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import styles from './SettingsSecondaryNav.module.css'

interface NavItem {
  label: string
  href: string
}

const ITEMS: NavItem[] = [
  { label: 'Company',      href: '/settings/company' },
  { label: 'Team',         href: '/settings/team' },
  { label: 'Subscription', href: '/settings/subscription' },
]

/**
 * Secondary nav for the settings section.
 * Company, Team, and Subscription tabs.
 */
export default function SettingsSecondaryNav() {
  const pathname = usePathname()

  function isActive(href: string): boolean {
    return pathname.startsWith(href)
  }

  return (
    <nav className={styles.nav}>
      {ITEMS.map((item) => (
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
