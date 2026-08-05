import type { ReactNode } from 'react'
import Link from 'next/link'
import styles from './AuthShell.module.css'

interface AuthShellProps {
  children: ReactNode
  /**
   * The design shows the TERMS OF SERVICE / PRIVACY POLICY strip only on the
   * sign-in screen — but it's the only route to the legal pages from
   * signed-out state, so it ships on every auth screen. `footer="none"` is
   * available for a screen that needs to opt out later.
   */
  footer?: 'legal' | 'none'
}

/**
 * Shared container for every unauthenticated auth screen — centred flex,
 * fixed padding, optional legal-links strip pinned to the bottom. Renders no
 * state of its own; `AuthCard` carries the wordmark and per-screen width.
 */
export default function AuthShell({ children, footer = 'legal' }: AuthShellProps) {
  return (
    <div className={styles.shell}>
      {children}
      {footer === 'legal' && (
        <footer className={styles.legalFooter}>
          <Link href="/terms">TERMS OF SERVICE</Link>
          <Link href="/privacy">PRIVACY POLICY</Link>
        </footer>
      )}
    </div>
  )
}
