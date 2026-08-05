'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { Role } from '@/types'
import { useSupportContext } from '@/lib/support-context'
import { deleteSession } from '@/actions/auth'
import Icon from '@/components/ui/Icon'
import { TOP_NAV, BOOKINGS_ITEMS, settingsItemsForRole } from './nav-items'
import styles from './MobileMenu.module.css'

interface MobileMenuProps {
  role: Role
  name: string
  email: string
}

export function MobileMenu({ role, name, email }: MobileMenuProps) {
  const [open, setOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const pathname = usePathname()
  const router = useRouter()
  const { openHelp } = useSupportContext()

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

  const settingsItems = settingsItemsForRole(role)

  function isTopActive(href: string) {
    return pathname.startsWith(href)
  }

  function isSubActive(href: string) {
    return pathname === href || pathname.startsWith(href + '/')
  }

  async function handleSignOut() {
    setSigningOut(true)
    try {
      await deleteSession()
      router.push('/login')
    } catch (err) {
      console.error('Sign out failed:', err)
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <>
      {/* Hamburger trigger — only visible on mobile via CSS, hidden when sheet is open */}
      <button
        className={`${styles.trigger} ${open ? styles.triggerHidden : ''}`}
        onClick={() => setOpen(true)}
        aria-label="Open navigation menu"
      >
        <Icon name="menu" size={24} />
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
            <Icon name="close" size={24} />
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
                <Icon name={item.icon} size={18} />
                {item.label}
              </Link>
            ))}
          </div>

          {/* Contextual sub-nav: Bookings views */}
          {isBookings && (
            <div className={styles.section}>
              <p className={styles.sectionLabel}>View</p>
              {BOOKINGS_ITEMS.map((item) => (
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

          {/* More */}
          <div className={styles.section}>
            <p className={styles.sectionLabel}>More</p>
            <button
              className={styles.navItem}
              onClick={() => { openHelp(); setOpen(false) }}
            >
              <Icon name="help" size={18} />
              Help &amp; feedback
            </button>
          </div>

          {/* Signed in as */}
          <div className={styles.section}>
            <p className={styles.sectionLabel}>Signed in as</p>
            <div className={styles.signedInRow}>
              <div className={styles.signedInInfo}>
                <span className={styles.signedInName}>{name}</span>
                <span className={styles.signedInEmail}>{email}</span>
              </div>
              <button
                className={styles.signOutBtn}
                onClick={handleSignOut}
                disabled={signingOut}
              >
                SIGN OUT
              </button>
            </div>
          </div>
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
