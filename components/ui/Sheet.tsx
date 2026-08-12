'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Icon from './Icon'
import styles from './Sheet.module.css'

interface SheetProps {
  open: boolean
  onClose: () => void
  /** Small caps line above the title, e.g. "EDIT UNIT". */
  eyebrow?: string
  title?: string
  children: ReactNode
  footer?: ReactNode
  /**
   * Renders the panel as a column inside the page on desktop — no scrim, no
   * focus trap, the page stays scrollable — while mobile keeps the bottom
   * drawer. Use when the panel sits beside the content it edits rather than
   * covering it. The caller owns the column; the panel fills it.
   */
  docked?: boolean
  /**
   * Replaces the ✕ with a text dismiss, e.g. "DONE". The booking form's date
   * and notes drawers are filled in and confirmed rather than closed, and the
   * design labels them accordingly; an editor panel keeps the icon.
   */
  dismissLabel?: string
  className?: string
}

const MOBILE_QUERY = '(max-width: 768px)'

/**
 * Side panel on desktop, bottom drawer on mobile — one component, one code
 * path, the breakpoint switch lives entirely in the CSS module.
 */
export default function Sheet({
  open,
  onClose,
  eyebrow,
  title,
  children,
  footer,
  docked = false,
  dismissLabel,
  className,
}: SheetProps) {
  // A docked panel is only modal on mobile, where it covers the page.
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY)
    const sync = () => setIsMobile(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  const modal = !docked || isMobile

  useEffect(() => {
    if (!open) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)

    if (!modal) {
      return () => document.removeEventListener('keydown', onKeyDown)
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose, modal])

  if (!open) return null

  const overlayClasses = [styles.overlay, docked ? styles.docked : ''].filter(Boolean).join(' ')
  const panelClasses = [styles.panel, className ?? ''].filter(Boolean).join(' ')

  return (
    // Docked on desktop the overlay is a plain static wrapper the size of the
    // panel, so this click handler only ever fires as scrim-dismiss on mobile.
    <div className={overlayClasses} onClick={onClose}>
      <aside
        role={modal ? 'dialog' : 'complementary'}
        aria-modal={modal || undefined}
        aria-label={title ?? eyebrow}
        className={panelClasses}
        onClick={(e) => e.stopPropagation()}
      >
        {(title || eyebrow) && (
          <div className={styles.header}>
            <div className={styles.heading}>
              {eyebrow && <span className={styles.eyebrow}>{eyebrow}</span>}
              {title && <h2 className={styles.title}>{title}</h2>}
            </div>
            <button
              type="button"
              className={dismissLabel ? styles.dismiss : styles.close}
              onClick={onClose}
              aria-label={dismissLabel ? undefined : 'Close'}
            >
              {dismissLabel ?? <Icon name="close" size={18} />}
            </button>
          </div>
        )}
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </aside>
    </div>
  )
}
