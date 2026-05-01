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
  return (
    <span className={`${styles.badge} ${styles[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  )
}
