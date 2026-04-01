'use client'
import { useActionState } from 'react'
import { createUnit, updateUnit } from '@/actions/equipment'
import type { EquipmentUnit } from '@/types'
import styles from './EquipmentForm.module.css'

interface UnitFormProps {
  equipmentId: string
  unit?: EquipmentUnit  // if provided, editing; else creating
  onSuccess?: () => void
}

export function UnitForm({ equipmentId, unit, onSuccess }: UnitFormProps) {
  const isEditing = !!unit

  const action = isEditing
    ? updateUnit.bind(null, equipmentId, unit.id)
    : createUnit.bind(null, equipmentId)

  const [state, formAction, isPending] = useActionState(
    async (_prev: unknown, formData: FormData) => {
      const result = await action(formData)
      if (!result || !('error' in result)) { onSuccess?.(); return null }
      return result
    },
    null,
  )

  return (
    <form action={formAction} className={styles.form}>
      <h2 className={styles.title}>{isEditing ? 'Edit Unit' : 'Add Unit'}</h2>
      {state?.error && <p className={styles.error}>{state.error}</p>}

      <div className={styles.field}>
        <label className={styles.label}>Label</label>
        <input name="label" className={styles.input} defaultValue={unit?.label ?? ''} required />
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Serial Number</label>
        <input name="serialNumber" className={styles.input} defaultValue={unit?.serialNumber ?? ''} />
      </div>

      {isEditing && (
        <div className={styles.field}>
          <label className={styles.label}>Status</label>
          <select name="status" className={styles.input} defaultValue={unit.status}>
            <option value="available">Available</option>
            <option value="checked_out">Checked Out</option>
            <option value="needs_repair">Needs Repair</option>
          </select>
        </div>
      )}

      <div className={styles.field}>
        <label className={styles.label}>Notes</label>
        <textarea name="notes" className={styles.input} defaultValue={unit?.notes ?? ''} rows={3} />
      </div>

      <button type="submit" disabled={isPending} className={styles.submitBtn}>
        {isPending ? 'Saving...' : isEditing ? 'Save Changes' : 'Add Unit'}
      </button>
    </form>
  )
}
