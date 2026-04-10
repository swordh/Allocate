'use client'

import { useState, useEffect, useCallback } from 'react'
import { updateEquipmentWithUnits, deactivateEquipment, createEquipmentWithUnits } from '@/actions/equipment'
import { useCategories } from '@/hooks/useCategories'
import { useMembers } from '@/hooks/useMembers'
import type { Equipment, EquipmentStatus, TrackingType, CustomField, CustomFieldType } from '@/types'
import type { UnitUpdate, UnitCreate, EquipmentFields } from '@/actions/equipment'
import styles from './EquipmentEditModal.module.css'

// ── Types ─────────────────────────────────────────────────────────────────────

interface UnitRow {
  tempId: string
  id: string | null  // null = new unit not yet saved
  label: string
  serialNumber: string | null
  status: EquipmentStatus
  notes: string | null
  availableForBooking: boolean
}

interface Props {
  isOpen: boolean
  onClose: () => void
  companyId: string
  equipment?: Equipment  // optional — absence = create mode
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function EquipmentEditModal({ isOpen, onClose, companyId, equipment }: Props) {
  const { categories } = useCategories(companyId)
  const { members } = useMembers(companyId)

  const isEditMode = !!equipment

  // Equipment fields
  const [name, setName] = useState(equipment?.name ?? '')
  const [category, setCategory] = useState(equipment?.category ?? '')
  const [description, setDescription] = useState(equipment?.description ?? '')
  const [requiresApproval, setRequiresApproval] = useState(equipment?.requiresApproval ?? false)
  const [approverId, setApproverId] = useState(equipment?.approverId ?? '')

  // Create-mode fields
  const [trackingType, setTrackingType] = useState<TrackingType>(equipment?.trackingType ?? 'serialized')
  const [totalQuantity, setTotalQuantity] = useState(equipment?.totalQuantity ?? 1)
  const [customFields, setCustomFields] = useState<CustomField[]>(equipment?.customFields ?? [])

  // Unit rows
  const [unitRows, setUnitRows] = useState<UnitRow[]>([])
  const [deletedIds, setDeletedIds] = useState<string[]>([])

  // UI state
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset all state when modal opens with (possibly new) equipment
  useEffect(() => {
    if (!isOpen) return
    setName(equipment?.name ?? '')
    setCategory(equipment?.category ?? '')
    setDescription(equipment?.description ?? '')
    setRequiresApproval(equipment?.requiresApproval ?? false)
    setApproverId(equipment?.approverId ?? '')
    setTrackingType(equipment?.trackingType ?? 'serialized')
    setTotalQuantity(equipment?.totalQuantity ?? 1)
    setCustomFields(equipment?.customFields ?? [])
    setDeletedIds([])
    setError(null)
    setUnitRows(
      (equipment?.units ?? []).map((u) => ({
        tempId: u.id,
        id: u.id,
        label: u.label,
        serialNumber: u.serialNumber,
        status: u.status,
        notes: u.notes,
        availableForBooking: u.availableForBooking,
      })),
    )
  }, [isOpen, equipment])

  const handleEscape = useCallback(
    (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() },
    [onClose],
  )

  useEffect(() => {
    if (!isOpen) return
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen, handleEscape])

  if (!isOpen) return null

  // ── Custom field helpers ───────────────────────────────────────────────────

  function addField() {
    setCustomFields((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).slice(2, 8),
        label: '',
        type: 'text',
        value: '',
      },
    ])
  }

  function removeField(id: string) {
    setCustomFields((prev) => prev.filter((f) => f.id !== id))
  }

  function updateField(id: string, patch: Partial<CustomField>) {
    setCustomFields((prev) =>
      prev.map((f) => (f.id === id ? ({ ...f, ...patch } as CustomField) : f)),
    )
  }

  function handleTypeChange(id: string, newType: CustomFieldType) {
    const value = newType === 'text' ? '' : { min: 0, max: null }
    updateField(id, { type: newType, value } as Partial<CustomField>)
  }

  // ── Unit row helpers ───────────────────────────────────────────────────────

  function addUnit() {
    setUnitRows((prev) => [
      ...prev,
      {
        tempId: Math.random().toString(36).slice(2),
        id: null,
        label: '',
        serialNumber: null,
        status: 'available',
        notes: null,
        availableForBooking: true,
      },
    ])
  }

  function updateRow(tempId: string, patch: Partial<UnitRow>) {
    setUnitRows((prev) => prev.map((r) => (r.tempId === tempId ? { ...r, ...patch } : r)))
  }

  function deleteRow(row: UnitRow) {
    if (row.id) setDeletedIds((prev) => [...prev, row.id!])
    setUnitRows((prev) => prev.filter((r) => r.tempId !== row.tempId))
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async function handleSave() {
    setSubmitting(true)
    setError(null)

    if (isEditMode) {
      const fields: EquipmentFields = {
        name: name.trim(),
        category,
        description: description.trim() || null,
        requiresApproval,
        approverId: approverId || null,
        customFields,
      }

      const unitUpdates: UnitUpdate[] = unitRows
        .filter((r) => r.id !== null)
        .map((r) => ({
          id: r.id!,
          label: r.label,
          serialNumber: r.serialNumber,
          status: r.status,
          notes: r.notes,
          availableForBooking: r.availableForBooking,
        }))

      const unitCreates: UnitCreate[] = unitRows
        .filter((r) => r.id === null)
        .map((r) => ({
          label: r.label,
          serialNumber: r.serialNumber,
          status: r.status,
          notes: r.notes,
          availableForBooking: r.availableForBooking,
        }))

      const result = await updateEquipmentWithUnits(
        equipment!.id, fields, unitUpdates, unitCreates, deletedIds,
      )

      setSubmitting(false)
      if (result?.error) {
        setError(result.error)
      } else {
        onClose()
      }
    } else {
      // Create mode
      const fields = {
        name: name.trim(),
        category,
        description: description.trim() || null,
        trackingType,
        totalQuantity: trackingType === 'quantity' ? totalQuantity : 1,
        requiresApproval,
        approverId: approverId || null,
        customFields,
      }

      const unitCreates: UnitCreate[] = trackingType === 'serialized'
        ? unitRows.map((r) => ({
            label: r.label,
            serialNumber: r.serialNumber,
            status: r.status,
            notes: r.notes,
            availableForBooking: r.availableForBooking,
          }))
        : []

      const result = await createEquipmentWithUnits(fields, unitCreates)

      setSubmitting(false)
      if ('error' in result) {
        setError(result.error)
      } else {
        onClose()
      }
    }
  }

  async function handleDelete() {
    if (!equipment) return
    if (!confirm(`Delete "${equipment.name}"? This cannot be undone.`)) return
    setDeleting(true)
    setError(null)
    const result = await deactivateEquipment(equipment.id)
    if ('requiresForce' in result) {
      const { affectedBookingCount } = result
      const confirmed = confirm(
        `"${equipment.name}" has ${affectedBookingCount} active booking${affectedBookingCount !== 1 ? 's' : ''}. Delete anyway?`,
      )
      if (!confirmed) {
        setDeleting(false)
        return
      }
      const forceResult = await deactivateEquipment(equipment.id, true)
      setDeleting(false)
      if ('error' in forceResult) {
        setError(forceResult.error)
      } else {
        onClose()
      }
    } else {
      setDeleting(false)
      if ('error' in result) {
        setError(result.error)
      } else {
        onClose()
      }
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={styles.backdrop} onClick={onClose} aria-modal="true" role="dialog">
      <section className={styles.modal} onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className={styles.header}>
          <div>
            <p className={styles.breadcrumb}>Equipment / {isEditMode ? 'Edit' : 'Add'}</p>
            <h2 className={styles.title}>{isEditMode ? equipment!.name : 'Add Equipment'}</h2>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {/* Scrollable body */}
        <div className={styles.body}>

          {/* Section A: Basic settings */}
          <div className={styles.section}>
            <p className={styles.sectionLabel}>Basic Settings</p>

            <div className={styles.grid2}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={100}
                  className={styles.input}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Category</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className={styles.select}
                >
                  <option value="">Select category</option>
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.name}>{cat.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel}>
                Description <span className={styles.optional}>(optional)</span>
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className={styles.textarea}
                placeholder="Optional description..."
              />
            </div>

            <div className={styles.approvalRow}>
              <button
                type="button"
                className={`${styles.toggle} ${requiresApproval ? styles.toggleOn : ''}`}
                onClick={() => {
                  setRequiresApproval((v) => !v)
                  if (requiresApproval) setApproverId('')
                }}
                role="switch"
                aria-checked={requiresApproval}
              />
              <span className={styles.approvalLabel}>Requires approval when booked</span>
            </div>

            {requiresApproval && (
              <div className={styles.field}>
                <label className={styles.fieldLabel}>
                  Approver <span className={styles.optional}>(leave empty for any Admin)</span>
                </label>
                <select
                  value={approverId}
                  onChange={(e) => setApproverId(e.target.value)}
                  className={styles.select}
                >
                  <option value="">Any Admin</option>
                  {members.map((m) => (
                    <option key={m.uid} value={m.uid}>{m.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Section B: Tracking type */}
          <div className={styles.section}>
            <p className={styles.sectionLabel}>
              Tracking Type
              {isEditMode && <span className={styles.optional}> (cannot be changed)</span>}
            </p>
            <div className={styles.trackingToggleGroup}>
              <button
                type="button"
                className={`${styles.trackingToggleBtn} ${trackingType === 'serialized' ? styles.trackingToggleBtnActive : ''}`}
                onClick={() => { if (!isEditMode) setTrackingType('serialized') }}
                disabled={isEditMode}
              >
                Serialized (individual units)
              </button>
              <button
                type="button"
                className={`${styles.trackingToggleBtn} ${trackingType === 'quantity' ? styles.trackingToggleBtnActive : ''}`}
                onClick={() => { if (!isEditMode) setTrackingType('quantity') }}
                disabled={isEditMode}
              >
                Quantity
              </button>
            </div>
            {trackingType === 'quantity' && (
              <div className={`${styles.field} ${styles.fieldMt}`}>
                <label className={styles.fieldLabel}>Total Quantity</label>
                <input
                  type="number"
                  min={1}
                  value={totalQuantity}
                  onChange={(e) => setTotalQuantity(Math.max(1, parseInt(e.target.value, 10) || 1))}
                  className={styles.input}
                  disabled={isEditMode}
                />
              </div>
            )}
          </div>

          {/* Section C: Custom fields */}
          <div className={styles.section}>
            <div className={styles.customFieldsHeader}>
              <p className={styles.sectionLabel}>Custom Fields</p>
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
                          value: {
                            ...(field.value as { min: number; max: number | null }),
                            min: parseFloat(e.target.value) || 0,
                          },
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
                          value: {
                            ...(field.value as { min: number; max: number | null }),
                            max: raw === '' ? null : parseFloat(raw) || 0,
                          },
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

          {/* Section D: Units — serialized only */}
          {trackingType === 'serialized' && (
            <div className={styles.section}>
              <p className={styles.sectionLabel}>Units</p>

              {/* Column headers */}
              <div className={styles.unitTableHeader}>
                <div className={styles.colUnitSerial}>Unit / Serial</div>
                <div className={styles.colAvail}>Avail</div>
                <div className={styles.colStatus}>Status</div>
                <div className={styles.colNotes}>Notes</div>
                <div className={styles.colDelete} />
              </div>

              {/* Rows */}
              <div className={styles.unitTableRows}>
                {unitRows.map((row) => (
                  <div key={row.tempId} className={styles.unitTableRow}>

                    {/* Dot + label + S/N */}
                    <div className={`${styles.colUnitSerial} ${styles.unitIdentity}`}>
                      <span className={`${styles.dot} ${styles[`dot_${row.status}` as keyof typeof styles]}`} />
                      <div className={styles.unitInputStack}>
                        <input
                          type="text"
                          value={row.label}
                          onChange={(e) => updateRow(row.tempId, { label: e.target.value })}
                          placeholder="Label"
                          className={styles.inlineInput}
                        />
                        <input
                          type="text"
                          value={row.serialNumber ?? ''}
                          onChange={(e) =>
                            updateRow(row.tempId, { serialNumber: e.target.value || null })
                          }
                          placeholder="S/N (optional)"
                          className={`${styles.inlineInput} ${styles.serialInput}`}
                        />
                      </div>
                    </div>

                    {/* Availability toggle */}
                    <div className={styles.colAvail}>
                      <button
                        type="button"
                        className={`${styles.toggle} ${row.availableForBooking ? styles.toggleOn : ''}`}
                        onClick={() =>
                          updateRow(row.tempId, { availableForBooking: !row.availableForBooking })
                        }
                        role="switch"
                        aria-checked={row.availableForBooking}
                      />
                    </div>

                    {/* Status dropdown */}
                    <div className={styles.colStatus}>
                      <select
                        value={row.status}
                        onChange={(e) =>
                          updateRow(row.tempId, { status: e.target.value as EquipmentStatus })
                        }
                        className={`${styles.statusSelect} ${styles[`statusColor_${row.status}` as keyof typeof styles]}`}
                      >
                        <option value="available">Available</option>
                        <option value="checked_out">Checked Out</option>
                        <option value="needs_repair">Needs Repair</option>
                      </select>
                    </div>

                    {/* Notes */}
                    <div className={styles.colNotes}>
                      <input
                        type="text"
                        value={row.notes ?? ''}
                        onChange={(e) =>
                          updateRow(row.tempId, { notes: e.target.value || null })
                        }
                        placeholder="Add note..."
                        className={styles.inlineInput}
                      />
                    </div>

                    {/* Delete row */}
                    <div className={styles.colDelete}>
                      <button
                        type="button"
                        className={styles.deleteRowBtn}
                        onClick={() => deleteRow(row)}
                        aria-label="Delete unit"
                      >
                        <span className="material-symbols-outlined">delete</span>
                      </button>
                    </div>

                  </div>
                ))}
              </div>

              <div className={styles.addUnitRow}>
                <button type="button" className={styles.addUnitBtn} onClick={addUnit}>
                  <span className="material-symbols-outlined">add</span>
                  Add Unit
                </button>
              </div>
            </div>
          )}

          {error && <p className={styles.error}>{error}</p>}
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          {isEditMode ? (
            <button
              type="button"
              className={styles.deleteEquipBtn}
              onClick={handleDelete}
              disabled={deleting || submitting}
            >
              {deleting ? 'Deleting...' : 'Delete Equipment'}
            </button>
          ) : (
            <div />
          )}
          <div className={styles.footerRight}>
            <button
              type="button"
              className={styles.discardBtn}
              onClick={onClose}
              disabled={submitting || deleting}
            >
              Discard
            </button>
            <button
              type="button"
              className={styles.saveBtn}
              onClick={handleSave}
              disabled={submitting || deleting}
            >
              {submitting ? 'Saving...' : isEditMode ? 'Save' : 'Add Equipment'}
            </button>
          </div>
        </div>

      </section>
    </div>
  )
}
