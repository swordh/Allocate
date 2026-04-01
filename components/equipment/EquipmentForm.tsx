'use client'

import { useState, useEffect, useRef } from 'react'
import { createEquipment, updateEquipment } from '@/actions/equipment'
import { useCategories } from '@/hooks/useCategories'
import { useMembers } from '@/hooks/useMembers'
import { useAuth } from '@/lib/auth-context'
import type { Equipment, TrackingType, CustomField, CustomFieldType } from '@/types'
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
  const [description, setDescription] = useState(equipment?.description ?? '')
  const [category, setCategory] = useState(equipment?.category ?? '')
  const [trackingType, setTrackingType] = useState<TrackingType>(equipment?.trackingType ?? 'serialized')
  const [totalQuantity, setTotalQuantity] = useState(equipment?.totalQuantity ?? 1)
  const [requiresApproval, setRequiresApproval] = useState(equipment?.requiresApproval ?? false)
  const [approverId, setApproverId] = useState(equipment?.approverId ?? '')
  const [customFields, setCustomFields] = useState<CustomField[]>(equipment?.customFields ?? [])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const isEditMode = !!equipment

  // Focus name field on mount
  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  function addField() {
    setCustomFields(prev => [...prev, {
      id: Math.random().toString(36).slice(2, 8),
      label: '',
      type: 'text',
      value: '',
    }])
  }

  function removeField(id: string) {
    setCustomFields(prev => prev.filter(f => f.id !== id))
  }

  function updateField(id: string, patch: Partial<CustomField>) {
    setCustomFields(prev => prev.map(f => f.id === id ? { ...f, ...patch } as CustomField : f))
  }

  function handleTypeChange(id: string, newType: CustomFieldType) {
    const value = newType === 'text' ? '' : { min: 0, max: null }
    updateField(id, { type: newType, value } as Partial<CustomField>)
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!user) return

    setSubmitting(true)
    setError(null)

    const formData = new FormData()
    formData.set('name', name)
    formData.set('description', description)
    formData.set('category', category)
    formData.set('requiresApproval', String(requiresApproval))
    formData.set('approverId', approverId)
    formData.set('customFields', JSON.stringify(customFields))
    if (!isEditMode) {
      formData.set('trackingType', trackingType)
    }
    if (trackingType === 'quantity') {
      formData.set('totalQuantity', String(totalQuantity))
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

      {/* Description */}
      <div className={styles.field}>
        <label htmlFor="eq-description" className={styles.label}>
          Description <span className={styles.optional}>(optional)</span>
        </label>
        <textarea
          id="eq-description"
          value={description ?? ''}
          onChange={(e) => setDescription(e.target.value)}
          className={styles.input}
          rows={3}
          placeholder="Optional description"
        />
      </div>

      {/* Custom Fields */}
      <div className={styles.field}>
        <div className={styles.customFieldsHeader}>
          <span className={styles.label}>Custom Fields</span>
          <button type="button" onClick={addField} className={styles.addFieldBtn}>
            + Add field
          </button>
        </div>

        {customFields.map((field) => (
          <div key={field.id} className={styles.customFieldRow}>
            <input
              type="text"
              value={field.label}
              onChange={(e) => updateField(field.id, { label: e.target.value })}
              placeholder="Label"
              className={styles.input}
            />
            <select
              value={field.type}
              onChange={(e) => handleTypeChange(field.id, e.target.value as CustomFieldType)}
              className={styles.select}
            >
              <option value="text">Text</option>
              <option value="value">Value</option>
            </select>
            {field.type === 'text' && (
              <input
                type="text"
                value={field.value as string}
                onChange={(e) => updateField(field.id, { value: e.target.value })}
                placeholder="Value"
                className={styles.input}
              />
            )}
            {field.type === 'value' && (
              <>
                <input
                  type="number"
                  value={(field.value as { min: number; max: number | null }).min}
                  onChange={(e) =>
                    updateField(field.id, {
                      value: { ...(field.value as { min: number; max: number | null }), min: parseFloat(e.target.value) || 0 },
                    })
                  }
                  placeholder="Min"
                  className={styles.input}
                />
                <span className={styles.customFieldRangeSep}>–</span>
                <input
                  type="number"
                  value={(field.value as { min: number; max: number | null }).max ?? ''}
                  onChange={(e) => {
                    const raw = e.target.value
                    updateField(field.id, {
                      value: { ...(field.value as { min: number; max: number | null }), max: raw === '' ? null : parseFloat(raw) || 0 },
                    })
                  }}
                  placeholder="Max (optional)"
                  className={styles.input}
                />
              </>
            )}
            <button
              type="button"
              onClick={() => removeField(field.id)}
              className={styles.removeFieldBtn}
              aria-label="Remove field"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* Tracking type — immutable after creation */}
      <div className={styles.field}>
        <label className={styles.label}>
          Tracking Type
          {isEditMode && <span className={styles.optional}> (cannot be changed)</span>}
        </label>
        <div className={styles.toggleGroup}>
          <label className={`${styles.toggleOption} ${trackingType === 'serialized' ? styles.toggleActive : ''}`}>
            <input
              type="radio"
              name="trackingType"
              value="serialized"
              checked={trackingType === 'serialized'}
              onChange={() => setTrackingType('serialized')}
              disabled={isEditMode}
              className={styles.toggleRadio}
            />
            Serialized (individual units)
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
              {categoriesLoading ? 'Loading...' : 'Select category'}
            </option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.name}>
                {cat.name}
              </option>
            ))}
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
                {membersLoading ? 'Loading...' : 'Any Admin'}
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
          {submitting ? 'Saving...' : isEditMode ? 'Save Changes' : 'Add Equipment'}
        </button>
      </div>
    </form>
  )
}
