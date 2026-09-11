'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState, type RefObject } from 'react'
import { deleteSession } from '@/actions/auth'
import Popover from '@/components/ui/Popover'
import { OPERATOR_NAV } from '@/components/nav/nav-items'
import styles from './OperatorTopBar.module.css'

interface OperatorTopBarProps {
  email: string
  menuOpen: boolean
  onMenuOpen: () => void
  triggerRef: RefObject<HTMLButtonElement | null>
}

/**
 * Desktop header + mobile collapsed header, per design_handoff_allocate/
 * screens/operator/21 Operator - Customer list.dc.html lines 32-42 (desktop)
 * and its (Mobil) sibling lines 37-47.
 *
 * Deliberate divergence from the app shell, reviewed and accepted — do not
 * "fix" this toward PrimaryNav/MobileMenu parity: both headers live in this
 * one component because the design's mobile hamburger is a normal in-flow
 * button inside the header row, not a fixed-position overlay trigger like
 * MobileMenu.tsx's. Splitting the file to match the app shell's structure
 * would copy a layout whose reason (a trigger that has to sit outside
 * normal flow to float over the page) doesn't apply here.
 *
 * The design shows the ops email as plain text with no sign-out affordance.
 * An operator view you cannot sign out of isn't shippable, so the email is
 * a button that reveals a SIGN OUT popover — keyboard operable via
 * aria-expanded, and Popover already closes on Escape and outside click.
 */
export default function OperatorTopBar({ email, menuOpen, onMenuOpen, triggerRef }: OperatorTopBarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [accountOpen, setAccountOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  async function handleSignOut() {
    setSigningOut(true)
    try {
      await deleteSession()
      router.push('/login')
    } catch (err) {
      console.error('Sign out failed:', err)
      setSigningOut(false)
    }
  }

  return (
    <header className={styles.header}>
      <div className={styles.wordmarkGroup}>
        <span className={styles.wordmark}>ALLOCATE</span>
        <span className={styles.tag}>OPERATOR</span>
      </div>

      <nav className={styles.nav}>
        {OPERATOR_NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`${styles.link} ${pathname.startsWith(item.href) ? styles.linkActive : ''}`}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <div className={styles.account}>
        <button
          type="button"
          className={styles.emailBtn}
          onClick={() => setAccountOpen((o) => !o)}
          aria-expanded={accountOpen}
          aria-haspopup="true"
        >
          {email}
        </button>
        <Popover
          open={accountOpen}
          onClose={() => setAccountOpen(false)}
          anchor="right"
          className={styles.accountPopover}
        >
          <button
            type="button"
            className={styles.signOutBtn}
            onClick={handleSignOut}
            disabled={signingOut}
          >
            SIGN OUT
          </button>
        </Popover>
      </div>

      <button
        ref={triggerRef}
        type="button"
        className={styles.hamburger}
        onClick={onMenuOpen}
        aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
        aria-expanded={menuOpen}
      >
        <span className={styles.bar} />
        <span className={styles.bar} />
        <span className={styles.bar} />
      </button>
    </header>
  )
}
