import type { Role } from '@/types'
import styles from './EquipmentEmpty.module.css'

interface EquipmentEmptyProps {
  role: Role
  onAddClick: () => void
}

export default function EquipmentEmpty({ role, onAddClick }: EquipmentEmptyProps) {
  return (
    <div className={styles.wrapper}>
      <p className={styles.headline}>No equipment yet.</p>
      <p className={styles.sub}>Add your first item to get started.</p>
      {role === 'admin' && (
        <button className={styles.addBtn} onClick={onAddClick}>
          Add Equipment
        </button>
      )}
    </div>
  )
}
