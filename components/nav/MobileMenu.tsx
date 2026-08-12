'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { Role } from '@/types'
import { deleteSession } from '@/actions/auth'
import Icon from '@/components/ui/Icon'
import Glyph from '@/components/ui/Glyph'
import { useBookingFilters } from '@/hooks/useBookingFilters'
import { TOP_NAV, settingsItemsForRole } from './nav-items'
import styles from './MobileMenu.module.css'

interface MobileMenuProps {
  role: Role
  name: string
  email: string
}

/**
 * Mobile nav — a bottom sheet triggered by the header hamburger, per
 * design_handoff_allocate/screens/settings/12-16 Inställningar (Mobil).dc.html
 * lines 322–365 (structure identical in the Bookings mobile screen, line
 * 121+). The sheet is unmounted entirely while closed — matching the
 * design's own `sc-if value="{{ menuOpen }}"` — so it never contributes
 * keyboard tab stops when hidden.
 */
export function MobileMenu({ role, name, email }: MobileMenuProps) {
  const [open, setOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const pathname = usePathname()
  const router = useRouter()
  const sheetRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { showCancelled, onlyMine, toggleCancelled, toggleOnlyMine } = useBookingFilters()

  // Auto-close when the route changes.
  useEffect(() => { setOpen(false) }, [pathname])

  // While open: lock body scroll, move focus into the sheet, close on Escape,
  // and return focus to the trigger on close.
  useEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    document.body.style.overflow = 'hidden'
    sheetRef.current?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.body.style.overflow = ''
      document.removeEventListener('keydown', onKeyDown)
      trigger?.focus()
    }
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
      {/* Hamburger trigger — only visible on mobile via CSS. Toggles, same
          icon in both states (the design has no separate close glyph). */}
      <button
        ref={triggerRef}
        className={styles.trigger}
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'Close navigation menu' : 'Open navigation menu'}
        aria-expanded={open}
      >
        <Icon name="menu" size={24} />
      </button>

      {open && (
        <div className={styles.overlay} onClick={() => setOpen(false)}>
          <div
            ref={sheetRef}
            className={styles.sheet}
            role="dialog"
            aria-modal="true"
            aria-label="Main navigation"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.handle} aria-hidden="true" />

            {/* Primary nav */}
            <div className={styles.primaryNav}>
              {TOP_NAV.map((item) => {
                const active = isTopActive(item.href)
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`${styles.navRow} ${active ? styles.navRowActive : ''}`}
                  >
                    <Icon name={item.icon} size={20} strokeWidth={1.9} />
                    {item.label}
                    {active && <span className={styles.activeDot} aria-hidden="true" />}
                  </Link>
                )
              })}
            </div>

            {/* Contextual group: Settings screen shows the settings cards
                (per design, verbatim). Bookings screen shows the List/Week/
                Month/4 Weeks switcher — the design puts that switcher on the
                Bookings page itself as a horizontal chip row, not in this
                sheet, and no such component exists yet on mobile, so it stays
                here for now rather than removing the only way to reach those
                views on a phone. Flagged for follow-up. */}
            {isSettings && settingsItems.length > 0 && (
              <div className={styles.group}>
                <p className={styles.groupLabel}>Settings</p>
                <div className={styles.cardList}>
                  {settingsItems.map((item) => {
                    const active = isSubActive(item.href)
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={`${styles.card} ${active ? styles.cardActive : ''}`}
                      >
                        <span className={styles.cardLabel}>{item.label.toUpperCase()}</span>
                        <Glyph char="›" className={styles.cardChevron} />
                      </Link>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Booking filters. The design puts them here rather than on the
                page (screen 08 Mobil, "FILTER"), because the toolbar's own
                filter pills are desktop-only. `Active bookings only` from the
                design file is deliberately not built — decision 2026-08-11. */}
            {isBookings && (
              <div className={styles.group}>
                <p className={styles.groupLabel}>Filter</p>
                <div className={styles.filterList}>
                  {[
                    { key: 'cancelled', icon: 'eye' as const, label: 'Show cancelled', on: showCancelled, toggle: toggleCancelled },
                    { key: 'mine', icon: 'person' as const, label: 'Only mine', on: onlyMine, toggle: toggleOnlyMine },
                  ].map((filter) => (
                    <button
                      key={filter.key}
                      type="button"
                      role="switch"
                      aria-checked={filter.on}
                      onClick={filter.toggle}
                      className={`${styles.filterRow} ${filter.on ? styles.filterRowOn : ''}`}
                    >
                      <Icon name={filter.icon} size={18} strokeWidth={1.9} />
                      <span className={styles.filterLabel}>{filter.label}</span>
                      <span className={styles.filterTrack} aria-hidden="true">
                        <span className={styles.filterKnob} />
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Signed in as */}
            <div className={styles.group}>
              <p className={styles.groupLabel}>Signed in as</p>
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

            {/* Create CTA — bookings now has its own FAB on the page (phase 4),
                so only equipment still needs an entry point here. */}
            {isEquipment && role === 'admin' && (
              <div className={styles.sheetFooter}>
                <Link href="/equipment?add=1" className={styles.ctaBtn}>
                  New Equipment
                </Link>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
