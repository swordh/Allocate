import type { EquipmentStatus } from '@/types'
import styles from './EquipmentStatusBadge.module.css'

interface EquipmentStatusBadgeProps {
  status: EquipmentStatus
}

const STATUS_LABELS: Record<EquipmentStatus, string> = {
  ok:                 'Ok',
  needs_repair:       'Needs Repair',
  limited_operations: 'Limited Operations',
}

export default function EquipmentStatusBadge({ status }: EquipmentStatusBadgeProps) {
  const label = STATUS_LABELS[status] ?? 'Ok'
  const cssKey = (status in STATUS_LABELS ? status : 'ok') as EquipmentStatus
  return (
    <span className={`${styles.badge} ${styles[cssKey]}`}>
      {label}
    </span>
  )
}
