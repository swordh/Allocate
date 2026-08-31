import type { ReactNode } from 'react'
import StatusDot from './StatusDot'
import styles from './ErrorBanner.module.css'

export type NoticeTone = 'info' | 'danger' | 'neutral'

interface ErrorBannerProps {
  tone?: NoticeTone
  children: ReactNode
  /** Trailing slot, typically a small Button. */
  action?: ReactNode
  className?: string
}

const TONES: Record<NoticeTone, string> = {
  info: styles.info,
  danger: styles.danger,
  neutral: styles.neutral,
}

/** Tinted, bordered notice row with a leading status dot. */
export default function ErrorBanner({
  tone = 'danger',
  children,
  action,
  className,
}: ErrorBannerProps) {
  const classes = [styles.banner, TONES[tone], className ?? ''].filter(Boolean).join(' ')

  return (
    <div className={classes} role={tone === 'danger' ? 'alert' : 'status'}>
      <StatusDot size={5} className={styles.dot} />
      {/* Text + action share a wrapper so mobile can stack the CTA below the
          text instead of beside it (design: "CTA stacked below the text,
          align-self:flex-start") — see .body's mobile override below. */}
      <div className={styles.body}>
        <p className={styles.text}>{children}</p>
        {action}
      </div>
    </div>
  )
}
