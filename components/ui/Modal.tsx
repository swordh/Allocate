'use client'

import { useEffect, type ReactNode } from 'react'
import Icon from './Icon'
import styles from './Modal.module.css'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  /** Card width in px. Defaults to the design's 380. */
  width?: number
  children: ReactNode
  footer?: ReactNode
  className?: string
}

export default function Modal({
  open,
  onClose,
  title,
  width,
  children,
  footer,
  className,
}: ModalProps) {
  useEffect(() => {
    if (!open) return

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
    <div className={styles.overlay} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={className ? `${styles.card} ${className}` : styles.card}
        style={width ? { width } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className={styles.header}>
            <h2 className={styles.title}>{title}</h2>
            <button
              type="button"
              className={styles.close}
              onClick={onClose}
              aria-label="Close"
            >
              <Icon name="close" size={18} />
            </button>
          </div>
        )}
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>
  )
}
