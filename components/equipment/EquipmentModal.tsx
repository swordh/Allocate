'use client'

import { useState, useEffect, useCallback } from 'react'
import EquipmentForm from './EquipmentForm'
import { UnitForm } from './UnitForm'
import type { Equipment } from '@/types'
import styles from './EquipmentModal.module.css'

interface EquipmentModalProps {
  isOpen: boolean
  onClose: () => void
  companyId: string
  equipment?: Equipment
}

export default function EquipmentModal({
  isOpen,
  onClose,
  companyId,
  equipment,
}: EquipmentModalProps) {
  const [addingUnitForId, setAddingUnitForId] = useState<string | null>(null)

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (addingUnitForId) {
          setAddingUnitForId(null)
          onClose()
        } else {
          onClose()
        }
      }
    },
    [onClose, addingUnitForId],
  )

  useEffect(() => {
    if (!isOpen) return
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen, handleEscape])

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) setAddingUnitForId(null)
  }, [isOpen])

  if (!isOpen) return null

  return (
    <div className={styles.backdrop} onClick={onClose} aria-modal="true" role="dialog">
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        {addingUnitForId ? (
          <UnitForm
            equipmentId={addingUnitForId}
            onSuccess={onClose}
          />
        ) : (
          <EquipmentForm
            companyId={companyId}
            equipment={equipment}
            onSuccess={onClose}
            onCancel={onClose}
            onSuccessWithUnit={(id) => setAddingUnitForId(id)}
          />
        )}
      </div>
    </div>
  )
}
