'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { Role } from '@/types'
import styles from './SettingsSecondaryNav.module.css'

interface NavItem {
  label: string
  href: string
}

const ADMIN_ITEMS: NavItem[] = [
  { label: 'Company',      href: '/settings/company' },
  { label: 'Team',         href: '/settings/team' },
  { label: 'Subscription', href: '/settings/subscription' },
  { label: 'Preferences',  href: '/settings/preferences' },
]

const ACCOUNT_ITEM: NavItem = { label: 'Account', href: '/settings/account' }

interface SettingsSecondaryNavProps {
  role: Role
}

export default function SettingsSecondaryNav({ role }: SettingsSecondaryNavProps) {
  const pathname = usePathname()

  function isActive(href: string): boolean {
    return pathname === href || pathname.startsWith(href + '/')
  }

  const items = role === 'admin' ? [...ADMIN_ITEMS, ACCOUNT_ITEM] : [ACCOUNT_ITEM]

  return (
    <nav className={styles.nav}>
      {items.map((item) => (
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
