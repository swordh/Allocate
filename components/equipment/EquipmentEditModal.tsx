'use client'

import { useState, useEffect, useCallback } from 'react'
import { updateEquipmentWithUnits, deactivateEquipment } from '@/actions/equipment'
import { useCategories } from '@/hooks/useCategories'
import { useMembers } from '@/hooks/useMembers'
import type { Equipment, EquipmentStatus } from '@/types'
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
  equipment: Equipment
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function EquipmentEditModal({ isOpen, onClose, companyId, equipment }: Props) {
  const { categories } = useCategories(companyId)
  const { members } = useMembers(companyId)

  // Equipment fields
  const [name, setName] = useState(equipment.name)
  const [category, setCategory] = useState(equipment.category)
  const [description, setDescription] = useState(equipment.description ?? '')
  const [requiresApproval, setRequiresApproval] = useState(equipment.requiresApproval)
  const [approverId, setApproverId] = useState(equipment.approverId ?? '')

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
    setName(equipment.name)
    setCategory(equipment.category)
    setDescription(equipment.description ?? '')
    setRequiresApproval(equipment.requiresApproval)
    setApproverId(equipment.approverId ?? '')
    setDeletedIds([])
    setError(null)
    setUnitRows(
      (equipment.units ?? []).map((u) => ({
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

    const fields: EquipmentFields = {
      name: name.trim(),
      category,
      description: description.trim() || null,
      requiresApproval,
      approverId: approverId || null,
      customFields: equipment.customFields ?? [],
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
      equipment.id, fields, unitUpdates, unitCreates, deletedIds,
    )

    setSubmitting(false)
    if (result?.error) {
      setError(result.error)
    } else {
      onClose()
    }
  }

  async function handleDelete() {
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
            <p className={styles.breadcrumb}>Equipment / Edit</p>
            <h2 className={styles.title}>{equipment.name}</h2>
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

          {/* Section B: Units */}
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

          {error && <p className={styles.error}>{error}</p>}
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <button
            type="button"
            className={styles.deleteEquipBtn}
            onClick={handleDelete}
            disabled={deleting || submitting}
          >
            {deleting ? 'Deleting...' : 'Delete Equipment'}
          </button>
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
              {submitting ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>

      </section>
    </div>
  )
}
