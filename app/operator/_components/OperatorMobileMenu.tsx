'use client'

import { useEffect, useRef, type RefObject } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { deleteSession } from '@/actions/auth'
import Icon from '@/components/ui/Icon'
import { OPERATOR_NAV } from '@/components/nav/nav-items'
import styles from './OperatorMobileMenu.module.css'

interface OperatorMobileMenuProps {
  open: boolean
  email: string
  onClose: () => void
  triggerRef: RefObject<HTMLButtonElement | null>
}

/**
 * Right-side operator nav drawer — design_handoff_allocate/screens/operator/
 * "21 Operator - Customer list (Mobil).dc.html" lines 93-113 (geometry:
 * width 272px, max-width 80%, background var(--surface) = #0d0d0f exactly,
 * border-left var(--border-soft) = rgba(255,255,255,0.10) exactly).
 *
 * Rebuilt, not restyled: the old drawer stayed mounted with
 * role="dialog" aria-modal="true" at all times (only a CSS transform moved
 * it offscreen), so it was a focusable, screen-reader-reachable dialog even
 * while "closed". This inherits components/nav/MobileMenu.tsx's behaviour
 * instead (see its lines 21-28, 39-59): unmounted entirely while closed
 * (`if (!open) return null` below — this component itself stays mounted the
 * whole time, same as MobileMenu, so the route-change effect keeps working),
 * Escape closes, focus moves into the drawer on open and back to the
 * hamburger (via `triggerRef`, owned by OperatorShellClient since the
 * trigger lives in a sibling component here, not inside this one) on close,
 * body scroll lock, and prefers-reduced-motion disables the slide/fade.
 *
 * The design has no sign-out affordance anywhere. SIGN OUT is placed under
 * SIGNED IN AS exactly as MobileMenu.tsx does for the app shell.
 */
export default function OperatorMobileMenu({ open, email, onClose, triggerRef }: OperatorMobileMenuProps) {
  const pathname = usePathname()
  const router = useRouter()
  const drawerRef = useRef<HTMLDivElement>(null)

  // Auto-close when the route changes. This effect lives on the always-
  // mounted component instance, not on the conditionally-rendered drawer
  // markup below, so it never fires spuriously on drawer open/close.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { onClose() }, [pathname])

  useEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    document.body.style.overflow = 'hidden'
    drawerRef.current?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.body.style.overflow = ''
      document.removeEventListener('keydown', onKeyDown)
      trigger?.focus()
    }
  }, [open, onClose, triggerRef])

  function isActive(href: string) {
    return pathname.startsWith(href)
  }

  async function handleSignOut() {
    // Close first. Otherwise router.push unmounts the whole shell — hamburger
    // included — while `open` is still true, and the effect cleanup then calls
    // focus() on a detached node. Harmless but silent; closing makes the
    // focus-return run against a trigger that still exists.
    onClose()
    try {
      await deleteSession()
      router.push('/login')
    } catch (err) {
      console.error('Sign out failed:', err)
    }
  }

  if (!open) return null

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        ref={drawerRef}
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-label="Operator navigation"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.top}>
          <span className={styles.tag}>OPERATOR</span>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close navigation menu"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <nav className={styles.nav}>
          {OPERATOR_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.navItem} ${isActive(item.href) ? styles.navItemActive : ''}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className={styles.account}>
          <span className={styles.accountLabel}>SIGNED IN AS</span>
          <span className={styles.email}>{email}</span>
          <button type="button" className={styles.signOutBtn} onClick={handleSignOut}>
            SIGN OUT
          </button>
        </div>
      </div>
    </div>
  )
}
