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
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const onPointerDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    // Deferred so the click that opened the popover does not immediately close it.
    const id = window.setTimeout(() => document.addEventListener('mousedown', onPointerDown))
    document.addEventListener('keydown', onKeyDown)

    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  if (!open) return null

  const classes = [
    styles.popover,
    anchor === 'right' ? styles.right : styles.left,
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div ref={ref} className={classes}>
      {children}
    </div>
  )
}
