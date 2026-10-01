'use client'

import { useEffect, type ReactNode } from 'react'
import styles from './FullScreenSheet.module.css'

interface FullScreenSheetProps {
  open: boolean
  /** Omit for a non-dismissible sheet — no Escape handler, no close affordance rendered by this component. */
  onClose?: () => void
  children: ReactNode
  footer?: ReactNode
  className?: string
}

/**
 * Full-frame (`inset:0`) mobile sheet — distinct from `Sheet.tsx` (a side
 * panel on desktop / bottom drawer on mobile) and `Modal.tsx` (a centered
 * card). Built for issue #352's leave-company flow, whose mobile design is a
 * full-screen sheet rather than either of those.
 */
export default function FullScreenSheet({ open, onClose, children, footer, className }: FullScreenSheetProps) {
  useEffect(() => {
    if (!open || !onClose) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      className={className ? `${styles.sheet} ${className}` : styles.sheet}
    >
      <div className={styles.body}>{children}</div>
      {footer && <div className={styles.footer}>{footer}</div>}
    </div>
  )
}
