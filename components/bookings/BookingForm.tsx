'use client'

import { useState, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createBooking, checkConflict } from '@/actions/bookings'
import type { Equipment, BookingItem } from '@/types'
import type { ConflictResult } from '@/actions/bookings'
import styles from './BookingForm.module.css'

interface BookingFormProps {
  companyId: string
  equipment: Equipment[]
  defaultStartDate: string
  defaultEndDate: string
  /** When provided, the form is in edit mode. Not used for new bookings. */
  bookingId?: string
}

interface SelectedItem {
  equipmentId: string
  unitId?: string
  quantity: number
}

// ---------------------------------------------------------------------------
// Equipment grouped by category
// ---------------------------------------------------------------------------

function groupByCategory(equipment: Equipment[]): Map<string, Equipment[]> {
  const map = new Map<string, Equipment[]>()
  for (const item of equipment) {
    if (!map.has(item.category)) map.set(item.category, [])
    map.get(item.category)!.push(item)
  }
  return map
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function BookingForm({
  companyId,
  equipment,
  defaultStartDate,
  defaultEndDate,
}: BookingFormProps) {
  const router = useRouter()

  const [projectName, setProjectName]   = useState('')
  const [startDate, setStartDate]       = useState(defaultStartDate)
  const [endDate, setEndDate]           = useState(defaultEndDate)
  const [notes, setNotes]               = useState('')
  const [selectedItems, setSelectedItems] = useState<SelectedItem[]>([])
  const [error, setError]               = useState<string | null>(null)
  const [conflictResult, setConflictResult] = useState<ConflictResult | null>(null)
  const [isCheckingConflict, setIsCheckingConflict] = useState(false)
  const [isPending, startTransition]    = useTransition()

  const grouped = useMemo(() => groupByCategory(equipment), [equipment])

  // ---------------------------------------------------------------------------
  // Derived: which equipment IDs have confirmed conflicts
  // ---------------------------------------------------------------------------
  const conflictIds = useMemo(() => {
    if (!conflictResult?.hasConflict) return new Set<string>()
    return new Set(conflictResult.conflicts.map((c) => c.equipmentId))
  }, [conflictResult])

  // ---------------------------------------------------------------------------
  // Equipment selection handlers
  // ---------------------------------------------------------------------------

  // For quantity equipment: selected when any item matches equipmentId (no unitId)
  function isSelected(id: string): boolean {
    return selectedItems.some((i) => i.equipmentId === id && !i.unitId)
  }

  // For serialized equipment: selected when a specific unit is in the list
  function isUnitSelected(equipmentId: string, unitId: string): boolean {
    return selectedItems.some((i) => i.equipmentId === equipmentId && i.unitId === unitId)
  }

  function getQuantity(id: string): number {
    return selectedItems.find((i) => i.equipmentId === id && !i.unitId)?.quantity ?? 1
  }

  function toggleItem(eq: Equipment) {
    setSelectedItems((prev) => {
      if (prev.some((i) => i.equipmentId === eq.id && !i.unitId)) {
        return prev.filter((i) => !(i.equipmentId === eq.id && !i.unitId))
      }
      return [...prev, { equipmentId: eq.id, quantity: 1 }]
    })
    setConflictResult(null)
  }

  function toggleUnit(equipmentId: string, unitId: string) {
    setSelectedItems((prev) => {
      if (prev.some((i) => i.equipmentId === equipmentId && i.unitId === unitId)) {
        return prev.filter((i) => !(i.equipmentId === equipmentId && i.unitId === unitId))
      }
      return [...prev, { equipmentId, unitId, quantity: 1 }]
    })
    setConflictResult(null)
  }

  function setQuantity(id: string, qty: number) {
    setSelectedItems((prev) =>
      prev.map((i) => (i.equipmentId === id && !i.unitId ? { ...i, quantity: qty } : i)),
    )
    setConflictResult(null)
  }

  // ---------------------------------------------------------------------------
  // Conflict check (runs when dates change)
  // ---------------------------------------------------------------------------

  async function handleDateChange(field: 'start' | 'end', value: string) {
    const newStart = field === 'start' ? value : startDate
    const newEnd   = field === 'end'   ? value : endDate

    if (field === 'start') setStartDate(value)
    else setEndDate(value)

    // If end is before start, fix it
    if (field === 'start' && value > endDate) {
      setEndDate(value)
    }

    if (selectedItems.length === 0) return
    if (!newStart || !newEnd) return

    const effectiveEnd = newEnd < newStart ? newStart : newEnd

    setIsCheckingConflict(true)
    try {
      const result = await checkConflict(
        companyId,
        newStart,
        effectiveEnd,
        selectedItems,
      )
      setConflictResult(result)
    } finally {
      setIsCheckingConflict(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Computed: which equipment requires approval
  // ---------------------------------------------------------------------------
  const requiresApproval = useMemo(() => {
    return selectedItems.some((item) => {
      const eq = equipment.find((e) => e.id === item.equipmentId)
      return eq?.requiresApproval
    })
  }, [selectedItems, equipment])

  // ---------------------------------------------------------------------------
  // Summary: selected equipment display
  // ---------------------------------------------------------------------------
  const selectedEquipment = useMemo(
    () =>
      selectedItems.map((item) => ({
        item,
        equipment: equipment.find((e) => e.id === item.equipmentId),
      })).filter((s) => s.equipment !== undefined),
    [selectedItems, equipment],
  )

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (selectedItems.length === 0) {
      setError('Select at least one equipment item.')
      return
    }

    // Run conflict check on submit (authoritative check is on the server)
    if (startDate && endDate) {
      const result = await checkConflict(companyId, startDate, endDate, selectedItems)
      setConflictResult(result)
      if (result.hasConflict) {
        setError('Some equipment is unavailable for the selected dates. Review conflicts below.')
        return
      }
    }

    const formData = new FormData()
    formData.set('projectName', projectName)
    formData.set('startDate', startDate)
    formData.set('endDate', endDate)
    formData.set('notes', notes)
    formData.set('items', JSON.stringify(selectedItems))

    startTransition(async () => {
      const result = await createBooking(formData)
      if ('error' in result) {
        setError(result.error)
      } else {
        router.push(`/bookings/${result.bookingId}`)
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const dateRangeLabel =
    startDate === endDate
      ? startDate
      : `${startDate} — ${endDate}`

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <div className={styles.layout}>
        {/* Left: form fields */}
        <div className={styles.fields}>
          <div className={styles.pageTitle}>New Booking</div>

          {error && (
            <div className={styles.errorBanner}>{error}</div>
          )}

          {/* Project name */}
          <div className={styles.field}>
            <label className={styles.label} htmlFor="projectName">
              Project Name
            </label>
            <input
              id="projectName"
              className={styles.input}
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Film title, shoot name..."
              maxLength={200}
              required
            />
          </div>

          {/* Dates */}
          <div className={styles.dateRow}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="startDate">
                Start Date
              </label>
              <input
                id="startDate"
                className={styles.input}
                type="date"
                value={startDate}
                onChange={(e) => handleDateChange('start', e.target.value)}
                required
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="endDate">
                End Date
              </label>
              <input
                id="endDate"
                className={styles.input}
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => handleDateChange('end', e.target.value)}
                required
              />
            </div>
          </div>

          {/* Equipment selector */}
          <div className={styles.field}>
            <div className={styles.label}>Equipment</div>
            {isCheckingConflict && (
              <div className={styles.conflictChecking}>Checking availability...</div>
            )}
            {equipment.length === 0 ? (
              <div className={styles.noEquipment}>
                No equipment available. Add equipment in Settings first.
              </div>
            ) : (
              <div className={styles.equipmentList}>
                {Array.from(grouped.entries()).map(([category, items]) => (
                  <div key={category} className={styles.category}>
                    <div className={styles.categoryLabel}>{category}</div>
                    {items.map((eq) => {
                      const hasConflict = conflictIds.has(eq.id)

                      if (eq.trackingType === 'serialized') {
                        const units = eq.units ?? []
                        return (
                          <div key={eq.id} className={styles.equipmentGroup}>
                            <div className={styles.equipmentGroupHeader}>
                              <span className={styles.equipmentName}>{eq.name}</span>
                              {eq.requiresApproval && (
                                <span className={styles.approvalTag}>Approval required</span>
                              )}
                              {hasConflict && (
                                <span className={styles.conflictTag}>Unavailable</span>
                              )}
                            </div>
                            {units.length === 0 ? (
                              <div className={styles.noUnits}>No units available</div>
                            ) : (
                              units.map((unit) => {
                                const unitSelected = isUnitSelected(eq.id, unit.id)
                                return (
                                  <label
                                    key={unit.id}
                                    className={`${styles.unitRow} ${unitSelected ? styles.unitRowSelected : ''}`}
                                  >
                                    <input
                                      type="checkbox"
                                      className={styles.checkbox}
                                      checked={unitSelected}
                                      onChange={() => toggleUnit(eq.id, unit.id)}
                                    />
                                    <span className={styles.unitLabel}>{unit.label}</span>
                                    {unit.serialNumber && (
                                      <span className={styles.unitSerial}>#{unit.serialNumber}</span>
                                    )}
                                  </label>
                                )
                              })
                            )}
                          </div>
                        )
                      }

                      // quantity equipment
                      const selected = isSelected(eq.id)
                      return (
                        <div
                          key={eq.id}
                          className={`${styles.equipmentRow} ${selected ? styles.equipmentRowSelected : ''} ${hasConflict ? styles.equipmentRowConflict : ''}`}
                        >
                          <label className={styles.equipmentLabel}>
                            <input
                              type="checkbox"
                              className={styles.checkbox}
                              checked={selected}
                              onChange={() => toggleItem(eq)}
                            />
                            <span className={styles.equipmentName}>{eq.name}</span>
                            {eq.requiresApproval && (
                              <span className={styles.approvalTag}>Approval required</span>
                            )}
                            {hasConflict && (
                              <span className={styles.conflictTag}>Unavailable</span>
                            )}
                          </label>
                          {selected && (
                            <div className={styles.quantityControl}>
                              <button
                                type="button"
                                className={styles.qtyBtn}
                                onClick={() =>
                                  setQuantity(eq.id, Math.max(1, getQuantity(eq.id) - 1))
                                }
                              >
                                −
                              </button>
                              <span className={styles.qtyValue}>{getQuantity(eq.id)}</span>
                              <button
                                type="button"
                                className={styles.qtyBtn}
                                onClick={() =>
                                  setQuantity(
                                    eq.id,
                                    Math.min(eq.totalQuantity, getQuantity(eq.id) + 1),
                                  )
                                }
                              >
                                +
                              </button>
                              <span className={styles.qtyMax}>/ {eq.totalQuantity}</span>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Notes */}
          <div className={styles.field}>
            <label className={styles.label} htmlFor="notes">
              Notes
            </label>
            <textarea
              id="notes"
              className={styles.textarea}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Special requirements, pickup instructions..."
              maxLength={2000}
              rows={4}
            />
          </div>

          {/* Submit */}
          <div className={styles.actions}>
            <button
              type="submit"
              className={styles.submitBtn}
              disabled={isPending || isCheckingConflict}
            >
              {isPending ? 'Creating...' : 'Create Booking'}
            </button>
          </div>
        </div>

        {/* Right: summary panel */}
        <div className={styles.summary}>
          <div className={styles.summaryTitle}>Summary</div>

          <div className={styles.summarySection}>
            <div className={styles.summaryLabel}>Dates</div>
            <div className={styles.summaryValue}>
              {startDate ? dateRangeLabel : '—'}
            </div>
          </div>

          <div className={styles.summarySection}>
            <div className={styles.summaryLabel}>
              Equipment ({selectedEquipment.length})
            </div>
            {selectedEquipment.length === 0 ? (
              <div className={styles.summaryEmpty}>None selected</div>
            ) : (
              <ul className={styles.summaryItems}>
                {selectedEquipment.map(({ item, equipment: eq }) => {
                  const key = item.unitId
                    ? `${item.equipmentId}:${item.unitId}`
                    : item.equipmentId
                  const unitLabel = item.unitId
                    ? eq!.units?.find((u) => u.id === item.unitId)?.label
                    : undefined
                  return (
                    <li key={key} className={styles.summaryItem}>
                      <span>
                        {eq!.name}
                        {unitLabel ? ` — ${unitLabel}` : ''}
                      </span>
                      {eq!.trackingType === 'quantity' && (
                        <span className={styles.summaryQty}>×{item.quantity}</span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {requiresApproval && (
            <div className={styles.approvalNotice}>
              One or more items require approval. Your booking will be submitted
              as Pending and reviewed before confirmation.
            </div>
          )}

          {conflictResult?.hasConflict && (
            <div className={styles.conflictNotice}>
              <div className={styles.conflictTitle}>Conflicts detected</div>
              {conflictResult.conflicts.map((c) => {
                const eq = equipment.find((e) => e.id === c.equipmentId)
                return (
                  <div key={c.equipmentId} className={styles.conflictItem}>
                    <span>{eq?.name ?? c.equipmentId}</span>
                    {c.reason === 'insufficient_quantity' && c.available !== undefined && (
                      <span className={styles.conflictDetail}>
                        Only {c.available} available
                      </span>
                    )}
                    {c.reason === 'already_booked' && (
                      <span className={styles.conflictDetail}>Already booked</span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </form>
  )
}
