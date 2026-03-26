'use client'

import { useEffect, useCallback } from 'react'
import EquipmentForm from './EquipmentForm'
import type { Equipment } from '@/types'
import styles from './EquipmentModal.module.css'

interface EquipmentModalProps {
  isOpen: boolean
  onClose: () => void
  companyId: string
  equipment?: Equipment   // present in edit mode
}

export default function EquipmentModal({
  isOpen,
  onClose,
  companyId,
  equipment,
}: EquipmentModalProps) {
  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose],
  )

  useEffect(() => {
    if (!isOpen) return
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen, handleEscape])

  if (!isOpen) return null

  return (
    <div className={styles.backdrop} onClick={onClose} aria-modal="true" role="dialog">
      <div
        className={styles.panel}
        onClick={(e) => e.stopPropagation()}
      >
        <EquipmentForm
          companyId={companyId}
          equipment={equipment}
          onSuccess={onClose}
          onCancel={onClose}
        />
      </div>
    </div>
  )
}
