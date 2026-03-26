'use client'

import { useState, useEffect, useRef } from 'react'
import { createEquipment, updateEquipment } from '@/actions/equipment'
import { useCategories } from '@/hooks/useCategories'
import { useMembers } from '@/hooks/useMembers'
import { useAuth } from '@/lib/auth-context'
import type { Equipment, EquipmentStatus, TrackingType } from '@/types'
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
  const [trackingType, setTrackingType] = useState<TrackingType>(equipment?.trackingType ?? 'individual')
  const [totalQuantity, setTotalQuantity] = useState(equipment?.totalQuantity ?? 1)
  const [serialNumber, setSerialNumber] = useState(equipment?.serialNumber ?? '')
  const [status, setStatus] = useState(equipment?.status ?? 'available')
  const [requiresApproval, setRequiresApproval] = useState(equipment?.requiresApproval ?? false)
  const [approverId, setApproverId] = useState(equipment?.approverId ?? '')
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
    if (!isEditMode) {
      formData.set('trackingType', trackingType)
    }
    if (trackingType === 'quantity') {
      formData.set('totalQuantity', String(totalQuantity))
    } else {
      formData.set('serialNumber', serialNumber)
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

      {/* Tracking type — immutable after creation */}
      <div className={styles.field}>
        <label className={styles.label}>
          Tracking Type
          {isEditMode && <span className={styles.optional}> (cannot be changed)</span>}
        </label>
        <div className={styles.toggleGroup}>
          <label className={`${styles.toggleOption} ${trackingType === 'individual' ? styles.toggleActive : ''}`}>
            <input
              type="radio"
              name="trackingType"
              value="individual"
              checked={trackingType === 'individual'}
              onChange={() => setTrackingType('individual')}
              disabled={isEditMode}
              className={styles.toggleRadio}
            />
            Individual
          </label>
          <label className={`${styles.toggleOption} ${trackingType === 'quantity' ? styles.toggleActive : ''}`}>
            <input
              type="radio"
              name="trackingType"
              value="quantity"
              checked={trackingType === 'quantity'}
              onChange={() => setTrackingType('quantity')}
              disabled={isEditMode}
              className={styles.toggleRadio}
            />
            Quantity
          </label>
        </div>
      </div>

      {/* Serial number — individual only */}
      {trackingType === 'individual' && (
        <div className={styles.field}>
          <label htmlFor="eq-serial" className={styles.label}>
            Serial Number <span className={styles.optional}>(optional)</span>
          </label>
          <input
            id="eq-serial"
            type="text"
            value={serialNumber}
            onChange={(e) => setSerialNumber(e.target.value)}
            className={styles.input}
            placeholder="e.g. K1.0012345"
          />
        </div>
      )}

      {/* Total quantity — quantity only */}
      {trackingType === 'quantity' && (
        <div className={styles.field}>
          <label htmlFor="eq-qty" className={styles.label}>Total Quantity</label>
          <input
            id="eq-qty"
            type="number"
            min={1}
            value={totalQuantity}
            onChange={(e) => setTotalQuantity(Math.max(1, parseInt(e.target.value, 10) || 1))}
            className={styles.input}
          />
        </div>
      )}

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
