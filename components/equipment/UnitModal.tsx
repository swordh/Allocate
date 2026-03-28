'use client'
import { UnitForm } from './UnitForm'
import type { EquipmentUnit } from '@/types'
import styles from './EquipmentModal.module.css'

interface UnitModalProps {
  equipmentId: string
  unit?: EquipmentUnit
  isOpen: boolean
  onClose: () => void
}

export function UnitModal({ equipmentId, unit, isOpen, onClose }: UnitModalProps) {
  if (!isOpen) return null
  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className={styles.closeBtn}>x</button>
        <UnitForm equipmentId={equipmentId} unit={unit} onSuccess={onClose} />
      </div>
    </div>
  )
}
