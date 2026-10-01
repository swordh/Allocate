'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import styles from './Popover.module.css'

interface PopoverProps {
  open: boolean
  onClose: () => void
  /** Horizontal alignment against the positioned parent. */
  anchor?: 'left' | 'right'
  children: ReactNode
  className?: string
  /**
   * Opt-in accessible-menu behaviour: `role="menu"` on the panel, focus moves
   * to the first `[role="menuitem"]` on open, and Up/Down/Home/End/Tab move
   * between menu items without letting focus leave the panel while it's
   * open. Off by default so existing callers (e.g. OperatorTopBar's simple
   * sign-out popover) are unaffected.
   */
  menu?: boolean
  /** Only meaningful with `menu` — labels the `role="menu"` panel for assistive tech. */
  ariaLabel?: string
}

function getMenuItems(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true',
  )
}

/**
 * Absolutely positioned panel. The caller supplies the positioning context —
 * wrap the trigger and this component in an element with `position: relative`.
 */
export default function Popover({
  open,
  onClose,
  anchor = 'left',
  children,
  className,
  menu = false,
  ariaLabel,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const onPointerDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }

      if (!menu || !ref.current) return

      const items = getMenuItems(ref.current)
      if (items.length === 0) return

      const active = document.activeElement as HTMLElement | null
      const currentIndex = active ? items.indexOf(active) : -1

      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault()
        items[(currentIndex + 1 + items.length) % items.length]?.focus()
      } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault()
        items[(currentIndex - 1 + items.length) % items.length]?.focus()
      } else if (e.key === 'Home') {
        e.preventDefault()
        items[0]?.focus()
      } else if (e.key === 'End') {
        e.preventDefault()
        items[items.length - 1]?.focus()
      }
    }

    // Deferred so the click that opened the popover does not immediately close it.
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', onPointerDown)
      if (menu) getMenuItems(ref.current!)[0]?.focus()
    })
    document.addEventListener('keydown', onKeyDown)

    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose, menu])

  if (!open) return null

  const classes = [
    styles.popover,
    anchor === 'right' ? styles.right : styles.left,
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div ref={ref} className={classes} role={menu ? 'menu' : undefined} aria-label={menu ? ariaLabel : undefined}>
      {children}
    </div>
  )
}
