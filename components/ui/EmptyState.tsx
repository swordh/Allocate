import type { ReactNode } from 'react'
import styles from './EmptyState.module.css'

interface EmptyStateProps {
  eyebrow?: string
  heading: string
  body?: string
  /** Typically a Button. */
  action?: ReactNode
  /**
   * 'inline' is the compact no-results treatment inside an existing list.
   * 'framed' is the dashed-border card the design uses when a whole page has
   * nothing in it yet — bigger heading, more air.
   */
  variant?: 'block' | 'inline' | 'framed'
  className?: string
}

export default function EmptyState({
  eyebrow,
  heading,
  body,
  action,
  variant = 'block',
  className,
}: EmptyStateProps) {
  const VARIANTS = { block: styles.block, inline: styles.inline, framed: styles.framed }

  const classes = [styles.empty, VARIANTS[variant], className ?? '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes}>
      {eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}
      <p className={styles.heading}>{heading}</p>
      {body && <p className={styles.body}>{body}</p>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  )
}
