'use client'

import { useState, useEffect, useRef } from 'react'
import { createEquipment, updateEquipment } from '@/actions/equipment'
import { useCategories } from '@/hooks/useCategories'
import { useMembers } from '@/hooks/useMembers'
import { useAuth } from '@/lib/auth-context'
import type { Equipment, EquipmentStatus } from '@/types'
import styles from './EquipmentForm.module.css'

interface EquipmentFormProps {
  companyId: string
  equipment?: Equipment   // present in edit mode
  onSuccess: () => void
  onCancel: () => void
}

export default function EquipmentForm({
  companyId,
  equipment,
  onSuccess,
  onCancel,
}: EquipmentFormProps) {
  const { user } = useAuth()
  const { categories, loading: categoriesLoading } = useCategories(companyId)
  const { members, loading: membersLoading } = useMembers(companyId)

  const [name, setName] = useState(equipment?.name ?? '')
  const [category, setCategory] = useState(equipment?.category ?? '')
  const [status, setStatus] = useState(equipment?.status ?? 'available')
  const [requiresApproval, setRequiresApproval] = useState(equipment?.requiresApproval ?? false)
  const [approverId, setApproverId] = useState(equipment?.approverId ?? '')
  const [active, setActive] = useState(equipment?.active ?? true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const isEditMode = !!equipment

  // Focus name field on mount
  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!user) return

    setSubmitting(true)
    setError(null)

    const formData = new FormData()
    formData.set('name', name)
    formData.set('category', category)
    formData.set('status', status)
    formData.set('requiresApproval', String(requiresApproval))
    formData.set('approverId', approverId)
    if (isEditMode) {
      formData.set('active', String(active))
    }

    let result: { id?: string; error?: string }
    if (isEditMode) {
      result = await updateEquipment(equipment.id, formData)
    } else {
      const createResult = await createEquipment(formData)
      result = 'id' in createResult ? { id: createResult.id } : { error: createResult.error }
    }

    setSubmitting(false)

    if (result.error) {
      setError(result.error)
    } else {
      onSuccess()
    }
  }

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <h2 className={styles.title}>
        {isEditMode ? 'Edit Equipment' : 'Add Equipment'}
      </h2>

      {/* Name */}
      <div className={styles.field}>
        <label htmlFor="eq-name" className={styles.label}>Name</label>
        <input
          ref={nameRef}
          id="eq-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          required
          className={styles.input}
          placeholder="e.g. Sony FX9"
        />
      </div>

      {/* Category */}
      <div className={styles.field}>
        <label htmlFor="eq-category" className={styles.label}>Category</label>
        <div className={styles.selectWrapper}>
          <select
            id="eq-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className={styles.select}
            disabled={categoriesLoading}
          >
            <option value="">
              {categoriesLoading ? 'Loading…' : 'Select category'}
            </option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.name}>
                {cat.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Status */}
      <div className={styles.field}>
        <label htmlFor="eq-status" className={styles.label}>Status</label>
        <div className={styles.selectWrapper}>
          <select
            id="eq-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as EquipmentStatus)}
            className={styles.select}
          >
            <option value="available">Available</option>
            <option value="checked_out">Checked Out</option>
            <option value="needs_repair">Needs Repair</option>
          </select>
        </div>
      </div>

      {/* Requires Approval */}
      <div className={styles.checkboxField}>
        <label className={styles.checkboxLabel}>
          <input
            type="checkbox"
            checked={requiresApproval}
            onChange={(e) => {
              setRequiresApproval(e.target.checked)
              if (!e.target.checked) setApproverId('')
            }}
            className={styles.checkbox}
          />
          <span>Requires approval when booked</span>
        </label>
      </div>

      {/* Approver — only shown when requiresApproval is true */}
      {requiresApproval && (
        <div className={styles.field}>
          <label htmlFor="eq-approver" className={styles.label}>
            Approver
            <span className={styles.optional}> (leave empty for any Admin)</span>
          </label>
          <div className={styles.selectWrapper}>
            <select
              id="eq-approver"
              value={approverId}
              onChange={(e) => setApproverId(e.target.value)}
              className={styles.select}
              disabled={membersLoading}
            >
              <option value="">
                {membersLoading ? 'Loading…' : 'Any Admin'}
              </option>
              {members.map((member) => (
                <option key={member.uid} value={member.uid}>
                  {member.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Active — edit mode only */}
      {isEditMode && (
        <div className={styles.checkboxField}>
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className={styles.checkbox}
            />
            <span>Active</span>
          </label>
        </div>
      )}

      {/* Error message */}
      {error && <p className={styles.error}>{error}</p>}

      {/* Actions */}
      <div className={styles.actions}>
        <button
          type="button"
          onClick={onCancel}
          className={styles.cancelBtn}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="submit"
          className={styles.submitBtn}
          disabled={submitting}
        >
          {submitting ? 'Saving…' : isEditMode ? 'Save Changes' : 'Add Equipment'}
        </button>
      </div>
    </form>
  )
}
