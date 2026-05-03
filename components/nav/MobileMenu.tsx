'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { Role } from '@/types'
import styles from './MobileMenu.module.css'

// ── Top-level nav ─────────────────────────────────────────────────────────────

const TOP_NAV = [
  { label: 'Bookings', href: '/bookings', icon: 'calendar_today' },
  { label: 'Equipment', href: '/equipment', icon: 'construction' },
  { label: 'Settings', href: '/settings', icon: 'settings' },
]

// ── Bookings sub-nav (mirrors BookingsSecondaryNav ITEMS) ─────────────────────

const BOOKINGS_ITEMS = [
  { label: 'List',    href: '/bookings/list' },
  { label: 'Week',    href: '/bookings/week' },
  { label: 'Month',   href: '/bookings/month', disabled: true },
  { label: '4 Weeks', href: '/bookings/4weeks', disabled: true },
]

// ── Settings sub-nav ──────────────────────────────────────────────────────────

const SETTINGS_ADMIN_ITEMS = [
  { label: 'Company',      href: '/settings/company' },
  { label: 'Team',         href: '/settings/team' },
  { label: 'Subscription', href: '/settings/subscription' },
  { label: 'Preferences',  href: '/settings/preferences' },
  { label: 'Account',      href: '/settings/account' },
]

const SETTINGS_MEMBER_ITEMS = [
  { label: 'Account', href: '/settings/account' },
]

// ─────────────────────────────────────────────────────────────────────────────

interface MobileMenuProps {
  role: Role
}

export function MobileMenu({ role }: MobileMenuProps) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  // Auto-close when the route changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setOpen(false) }, [pathname])

  // Prevent body scroll while sheet is open
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  const isBookings = pathname.startsWith('/bookings')
  const isEquipment = pathname.startsWith('/equipment')
  const isSettings = pathname.startsWith('/settings')

  const settingsItems = role === 'admin' ? SETTINGS_ADMIN_ITEMS : SETTINGS_MEMBER_ITEMS

  function isTopActive(href: string) {
    return pathname.startsWith(href)
  }

  function isSubActive(href: string) {
    return pathname === href || pathname.startsWith(href + '/')
  }

  return (
    <>
      {/* Hamburger trigger — only visible on mobile via CSS */}
      <button
        className={styles.trigger}
        onClick={() => setOpen(true)}
        aria-label="Open navigation menu"
      >
        <span className="material-symbols-outlined">menu</span>
      </button>

      {/* Backdrop */}
      <div
        className={`${styles.backdrop} ${open ? styles.backdropOpen : ''}`}
        onClick={() => setOpen(false)}
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
            onClick={() => setOpen(false)}
            aria-label="Close navigation menu"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className={styles.sheetBody}>
          {/* Top-level navigation */}
          <div className={styles.section}>
            <p className={styles.sectionLabel}>Navigate</p>
            {TOP_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`${styles.navItem} ${isTopActive(item.href) ? styles.navItemActive : ''}`}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                  {item.icon}
                </span>
                {item.label}
              </Link>
            ))}
          </div>

          {/* Contextual sub-nav: Bookings views */}
          {isBookings && (
            <div className={styles.section}>
              <p className={styles.sectionLabel}>View</p>
              {BOOKINGS_ITEMS.map((item) => {
                if (item.disabled) {
                  return (
                    <span
                      key={item.href}
                      className={styles.navItem}
                      style={{ opacity: 0.3, cursor: 'not-allowed' }}
                    >
                      {item.label}
                    </span>
                  )
                }
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`${styles.navItem} ${isSubActive(item.href) ? styles.navItemActive : ''}`}
                  >
                    {item.label}
                  </Link>
                )
              })}
            </div>
          )}

          {/* Contextual sub-nav: Settings */}
          {isSettings && (
            <div className={styles.section}>
              <p className={styles.sectionLabel}>Settings</p>
              {settingsItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`${styles.navItem} ${isSubActive(item.href) ? styles.navItemActive : ''}`}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Bottom CTA */}
        {(isBookings || (isEquipment && role === 'admin')) && (
          <div className={styles.sheetFooter}>
            {isBookings && (
              <Link href="/bookings/new" className={styles.ctaBtn}>
                New Booking
              </Link>
            )}
            {isEquipment && role === 'admin' && (
              <Link href="/equipment?add=1" className={styles.ctaBtn}>
                New Equipment
              </Link>
            )}
          </div>
        )}
      </div>
    </>
  )
}
