'use client'

import { useRef, useState } from 'react'
import OperatorTopBar from './OperatorTopBar'
import OperatorMobileMenu from './OperatorMobileMenu'

interface OperatorShellClientProps {
  email: string
}

/**
 * Owns the drawer's open state and the hamburger-button ref, shared between
 * the two sibling components below so OperatorMobileMenu can return focus
 * to the trigger on close (components/nav/MobileMenu.tsx keeps its trigger
 * inside the same component, so it doesn't need this — the operator header
 * renders its own inline hamburger per the design, in a different component).
 */
export default function OperatorShellClient({ email }: OperatorShellClientProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  return (
    <>
      <OperatorTopBar
        email={email}
        menuOpen={open}
        onMenuOpen={() => setOpen(true)}
        triggerRef={triggerRef}
      />
      <OperatorMobileMenu
        open={open}
        email={email}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
      />
    </>
  )
}
