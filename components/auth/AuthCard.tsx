import type { ReactNode } from 'react'
import styles from './AuthCard.module.css'

export type AuthCardWidth = 400 | 420 | 440
export type AuthCardGap = 22 | 24 | 26

const ENV_LABELS: Record<string, string> = {
  dev:   'Dev',
  alpha: 'Alpha',
  beta:  'Beta',
}

const ENV_CLASSES: Record<string, string> = {
  dev:   styles.envDev,
  alpha: styles.envAlpha,
  beta:  styles.envBeta,
}

interface AuthCardProps {
  width: AuthCardWidth
  /** Outer gap between the wordmark and the screen's content blocks — the design varies it 22–26px per screen. */
  gap?: AuthCardGap
  /**
   * Renders nothing on desktop. Under `max-width:480px` becomes the fixed
   * bottom action bar. Per the mobile design files: signup, verify-email and
   * auth-action use it; login and forgot-password don't — their buttons stay
   * in flow, so leave this unset there.
   */
  stickyActions?: ReactNode
  children: ReactNode
}

/** Fixed-width card with the ALLOCATE wordmark as its first child. Used inside `AuthShell`. */
export default function AuthCard({ width, gap = 26, stickyActions, children }: AuthCardProps) {
  const env = process.env.NEXT_PUBLIC_APP_ENV
  const envLabel = env ? ENV_LABELS[env] : undefined

  return (
    <div
      className={styles.card}
      data-width={width}
      data-gap={gap}
      data-has-sticky={stickyActions ? 'true' : undefined}
    >
      <div className={styles.wordmarkRow}>
        <span className={styles.wordmark}>ALLOCATE</span>
        {envLabel && env && (
          <span className={`${styles.envBadge} ${ENV_CLASSES[env] ?? ''}`}>{envLabel}</span>
        )}
      </div>

      {children}

      {stickyActions && <div className={styles.stickyActions}>{stickyActions}</div>}
    </div>
  )
}
