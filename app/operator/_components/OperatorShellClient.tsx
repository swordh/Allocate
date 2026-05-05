'use client'

import { useState } from 'react'
import OperatorTopBar from './OperatorTopBar'
import OperatorMobileMenu from './OperatorMobileMenu'

export default function OperatorShellClient() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <OperatorTopBar onMenuOpen={() => setOpen(true)} />
      <OperatorMobileMenu open={open} onClose={() => setOpen(false)} />
    </>
  )
}
