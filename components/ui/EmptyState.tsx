import type { ReactNode } from 'react'
import styles from './EmptyState.module.css'

interface EmptyStateProps {
  eyebrow?: string
  heading: string
  body?: string
  /** Typically a Button. */
  action?: ReactNode
  /** 'inline' is the compact no-results treatment inside an existing list. */
  variant?: 'block' | 'inline'
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
  const classes = [
    styles.empty,
    variant === 'inline' ? styles.inline : styles.block,
    className ?? '',
  ]
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
