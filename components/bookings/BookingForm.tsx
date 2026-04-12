'use client'

import { useState, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createBooking, checkConflict } from '@/actions/bookings'
import { useToast } from '@/lib/toast-context'
import type { Equipment } from '@/types'
import type { ConflictResult } from '@/actions/bookings'
import styles from './BookingForm.module.css'

interface BookingFormProps {
  companyId: string
  equipment: Equipment[]
  defaultStartDate: string
  defaultEndDate: string
}

interface SelectedItem {
  equipmentId: string
  unitId?: string
  quantity: number
}

function groupByCategory(equipment: Equipment[]): Map<string, Equipment[]> {
  const map = new Map<string, Equipment[]>()
  for (const item of equipment) {
    if (!map.has(item.category)) map.set(item.category, [])
    map.get(item.category)!.push(item)
  }
  return map
}

export default function BookingForm({
  companyId,
  equipment,
  defaultStartDate,
  defaultEndDate,
}: BookingFormProps) {
  const router = useRouter()
  const { showToast, dismissToast } = useToast()

  const [projectName, setProjectName]   = useState('')
  const [startDate, setStartDate]       = useState(defaultStartDate)
  const [endDate, setEndDate]           = useState(defaultEndDate)
  const [startTime, setStartTime]       = useState('')
  const [endTime, setEndTime]           = useState('')
  const [notes, setNotes]               = useState('')
  const [selectedItems, setSelectedItems] = useState<SelectedItem[]>([])
  const [error, setError]               = useState<string | null>(null)
  const [conflictResult, setConflictResult] = useState<ConflictResult | null>(null)
  const [isCheckingConflict, setIsCheckingConflict] = useState(false)
  const [isPending, startTransition]    = useTransition()

  const bookableEquipment = equipment.filter((e) => e.availableForBooking !== false)
  const grouped = useMemo(() => groupByCategory(bookableEquipment), [bookableEquipment])

  const conflictIds = useMemo(() => {
    if (!conflictResult?.hasConflict) return new Set<string>()
    return new Set(conflictResult.conflicts.map((c) => c.equipmentId))
  }, [conflictResult])

  // For quantity equipment
  function isSelected(id: string): boolean {
    return selectedItems.some((i) => i.equipmentId === id && !i.unitId)
  }

  // For serialized equipment: returns selected unitId or undefined
  function getSelectedUnitId(equipmentId: string): string | undefined {
    return selectedItems.find((i) => i.equipmentId === equipmentId && i.unitId)?.unitId
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

  function selectUnit(equipmentId: string, unitId: string) {
    setSelectedItems((prev) => {
      const without = prev.filter((i) => i.equipmentId !== equipmentId || !i.unitId)
      if (!unitId) return without
      return [...without, { equipmentId, unitId, quantity: 1 }]
    })
    setConflictResult(null)
  }

  function toggleSerializedItem(eq: Equipment) {
    const units = (eq.units ?? []).filter(u => u.availableForBooking !== false)
    setSelectedItems((prev) => {
      const hasSelection = prev.some((i) => i.equipmentId === eq.id && i.unitId)
      if (hasSelection) {
        return prev.filter((i) => i.equipmentId !== eq.id || !i.unitId)
      }
      const firstUnit = units[0]
      if (!firstUnit) return prev
      const without = prev.filter((i) => i.equipmentId !== eq.id || !i.unitId)
      return [...without, { equipmentId: eq.id, unitId: firstUnit.id, quantity: 1 }]
    })
    setConflictResult(null)
  }

  function setQuantity(id: string, qty: number) {
    setSelectedItems((prev) => {
      if (qty <= 0) {
        return prev.filter((i) => !(i.equipmentId === id && !i.unitId))
      }
      const exists = prev.some((i) => i.equipmentId === id && !i.unitId)
      if (exists) {
        return prev.map((i) => (i.equipmentId === id && !i.unitId ? { ...i, quantity: qty } : i))
      }
      return [...prev, { equipmentId: id, quantity: qty }]
    })
    setConflictResult(null)
  }

  async function handleDateChange(field: 'start' | 'end', value: string) {
    const newStart = field === 'start' ? value : startDate
    const newEnd   = field === 'end'   ? value : endDate

    if (field === 'start') setStartDate(value)
    else setEndDate(value)

    if (field === 'start' && value > endDate) {
      setEndDate(value)
    }

    if (selectedItems.length === 0) return
    if (!newStart || !newEnd) return

    const effectiveEnd = newEnd < newStart ? newStart : newEnd

    setIsCheckingConflict(true)
    try {
      const result = await checkConflict(companyId, newStart, effectiveEnd, selectedItems)
      setConflictResult(result)
    } finally {
      setIsCheckingConflict(false)
    }
  }

  const requiresApproval = useMemo(() => {
    return selectedItems.some((item) => {
      const eq = equipment.find((e) => e.id === item.equipmentId)
      return eq?.requiresApproval
    })
  }, [selectedItems, equipment])

  const selectedEquipment = useMemo(
    () =>
      selectedItems.map((item) => ({
        item,
        equipment: equipment.find((e) => e.id === item.equipmentId),
      })).filter((s) => s.equipment !== undefined),
    [selectedItems, equipment],
  )

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (selectedItems.length === 0) {
      setError('Select at least one equipment item.')
      return
    }

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
    if (startTime) formData.set('startTime', startTime)
    if (endTime) formData.set('endTime', endTime)
    formData.set('notes', notes)
    formData.set('items', JSON.stringify(selectedItems))

    const toastId = showToast('saving', 'Saving booking...')
    startTransition(async () => {
      const result = await createBooking(formData)
      dismissToast(toastId)
      if ('error' in result) {
        setError(result.error)
        showToast('error', result.error, 5000)
      } else {
        showToast('success', 'Booking created', 3000)
        router.push(`/bookings/${result.bookingId}`)
      }
    })
  }

  const dateRangeLabel =
    startDate === endDate ? startDate : `${startDate} — ${endDate}`

  const timeRangeLabel =
    startTime && endTime ? `${startTime} → ${endTime}`
    : startTime ? `From ${startTime}`
    : endTime ? `Until ${endTime}`
    : null

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <div className={styles.layout}>
        {/* Left: form fields */}
        <div className={styles.fields}>

          {error && (
            <div className={styles.errorBanner}>{error}</div>
          )}

          {/* Project name */}
          <div className={styles.field}>
            <label className={styles.label} htmlFor="projectName">
              Project / Title
            </label>
            <div className={styles.inputWrap}>
              <input
                id="projectName"
                className={styles.input}
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="e.g. Nordic Noir EP5 — Camera Package"
                maxLength={200}
                required
              />
            </div>
          </div>

          {/* Dates */}
          <div className={styles.field}>
            <div className={styles.sectionLabel}>Date</div>
            <div className={styles.dateRow}>
              <div>
                <label className={styles.label} htmlFor="startDate">Start Date</label>
                <div className={styles.inputWrap}>
                  <input
                    id="startDate"
                    className={styles.input}
                    type="date"
                    value={startDate}
                    onChange={(e) => handleDateChange('start', e.target.value)}
                    required
                  />
                </div>
              </div>
              <div>
                <label className={styles.label} htmlFor="endDate">End Date</label>
                <div className={styles.inputWrap}>
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
            </div>
          </div>

          {/* Times */}
          <div className={styles.field}>
            <div className={styles.sectionLabel}>Time</div>
            <div className={styles.dateRow}>
              <div>
                <label className={styles.label} htmlFor="startTime">Start Time</label>
                <div className={styles.inputWrap}>
                  <input
                    id="startTime"
                    className={styles.input}
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                  />
                </div>
              </div>
              <div>
                <label className={styles.label} htmlFor="endTime">End Time</label>
                <div className={styles.inputWrap}>
                  <input
                    id="endTime"
                    className={styles.input}
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Equipment */}
          <div className={styles.field}>
            <div className={styles.sectionLabel}>Equipment</div>
            {isCheckingConflict && (
              <div className={styles.conflictChecking}>Checking availability…</div>
            )}
            {bookableEquipment.length === 0 ? (
              <div className={styles.noEquipment}>
                {equipment.length === 0
                  ? 'No equipment available. Add equipment in the Equipment page first.'
                  : 'No equipment is currently available for booking.'}
              </div>
            ) : (
              <div className={styles.equipmentList}>
                {Array.from(grouped.entries()).map(([category, items]) => (
                  <section key={category} className={styles.category}>
                    <h2 className={styles.categoryLabel}>{category}</h2>
                    {items.map((eq) => {
                      const hasConflict = conflictIds.has(eq.id)

                      if (eq.trackingType === 'serialized') {
                        const units = (eq.units ?? []).filter(u => u.availableForBooking !== false)
                        const selectedUnitId = getSelectedUnitId(eq.id)
                        const isChecked = !!selectedUnitId

                        return (
                          <div key={eq.id} className={`${styles.equipmentBox} ${hasConflict ? styles.equipmentBoxConflict : ''}`}>
                            <label className={`${styles.equipmentRow} ${isChecked ? styles.equipmentRowSelected : ''}`}>
                              <div className={`${styles.customCheckbox} ${isChecked ? styles.customCheckboxChecked : ''}`}>
                                {isChecked && <span className={styles.checkIcon}>&#10003;</span>}
                              </div>
                              <input
                                type="checkbox"
                                className={styles.hiddenCheckbox}
                                checked={isChecked}
                                onChange={() => toggleSerializedItem(eq)}
                              />
                              <div className={styles.equipmentMeta}>
                                <span className={styles.equipmentName}>{eq.name}</span>
                                <span className={styles.typeTag}>UNITS</span>
                              </div>
                              {eq.requiresApproval && (
                                <span className={styles.approvalTag}>Approval required</span>
                              )}
                              {hasConflict && (
                                <span className={styles.conflictTag}>Unavailable</span>
                              )}
                            </label>
                            {isChecked && units.length > 0 && (
                              <div className={styles.unitDropdownRow}>
                                <span className={styles.unitDropdownLabel}>Which unit?</span>
                                <select
                                  className={styles.unitSelect}
                                  value={selectedUnitId ?? ''}
                                  onChange={(e) => selectUnit(eq.id, e.target.value)}
                                >
                                  {units.map((unit) => (
                                    <option key={unit.id} value={unit.id}>
                                      {unit.label}{unit.serialNumber ? ` — S/N ${unit.serialNumber}` : ''}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                            {isChecked && units.length === 0 && (
                              <div className={styles.unitDropdownRow}>
                                <span className={styles.noUnits}>No units available</span>
                              </div>
                            )}
                          </div>
                        )
                      }

                      // quantity equipment
                      const selected = isSelected(eq.id)
                      const qty = selected ? getQuantity(eq.id) : 0
                      return (
                        <div key={eq.id} className={`${styles.equipmentBox} ${hasConflict ? styles.equipmentBoxConflict : ''}`}>
                          <div className={`${styles.equipmentRow} ${selected ? styles.equipmentRowSelected : ''}`}>
                            <label className={styles.equipmentLabel}>
                              <div className={`${styles.customCheckbox} ${selected ? styles.customCheckboxChecked : ''}`}>
                                {selected && <span className={styles.checkIcon}>&#10003;</span>}
                              </div>
                              <input
                                type="checkbox"
                                className={styles.hiddenCheckbox}
                                checked={selected}
                                onChange={() => setQuantity(eq.id, selected ? 0 : 1)}
                              />
                              <div className={styles.equipmentMeta}>
                                <span className={styles.equipmentName}>{eq.name}</span>
                                <span className={styles.typeTag}>QTY</span>
                                {eq.requiresApproval && (
                                  <span className={styles.approvalTag}>Approval required</span>
                                )}
                                {hasConflict && (
                                  <span className={styles.conflictTag}>Unavailable</span>
                                )}
                              </div>
                            </label>
                            <div className={styles.quantityControl}>
                              <div className={styles.qtyInner}>
                                <button
                                  type="button"
                                  className={styles.qtyBtn}
                                  onClick={() => setQuantity(eq.id, qty - 1)}
                                >&#8722;</button>
                                <span className={styles.qtyValue}>{qty}</span>
                                <button
                                  type="button"
                                  className={styles.qtyBtn}
                                  onClick={() => setQuantity(eq.id, Math.min(eq.totalQuantity, qty + 1))}
                                >&#43;</button>
                              </div>
                              <span className={styles.qtyMax}>of {eq.totalQuantity}</span>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </section>
                ))}
              </div>
            )}
          </div>

          {/* Notes */}
          <div className={styles.field}>
            <label className={styles.label} htmlFor="notes">Notes</label>
            <textarea
              id="notes"
              className={styles.textarea}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any additional notes or special requirements…"
              maxLength={2000}
              rows={4}
            />
          </div>
        </div>

        {/* Right: summary panel */}
        <div className={styles.summary}>
          <div className={styles.summaryTitle}>Booking Summary</div>

          {/* Selected items */}
          <div>
            {selectedEquipment.length === 0 ? (
              <div className={styles.summaryEmpty}>No items selected</div>
            ) : (
              <div>
                {selectedEquipment.map(({ item, equipment: eq }) => {
                  const key = item.unitId ? `${item.equipmentId}:${item.unitId}` : item.equipmentId
                  const unitLabel = item.unitId
                    ? eq!.units?.find((u) => u.id === item.unitId)?.label
                    : undefined
                  return (
                    <div key={key} className={styles.summaryItem}>
                      <span className={styles.summaryItemName}>{eq!.name}</span>
                      <span className={styles.summaryItemDetail}>
                        {unitLabel ?? (eq!.trackingType === 'quantity' ? `\u00d7${item.quantity}` : '')}
                      </span>
                    </div>
                  )
                })}
                <div className={styles.summaryCount}>
                  {selectedEquipment.length} item{selectedEquipment.length !== 1 ? 's' : ''} selected
                </div>
              </div>
            )}
          </div>

          {/* Date */}
          <div className={styles.summarySection}>
            <div className={styles.summaryLabel}>Date</div>
            <div className={styles.summaryValue}>{startDate ? dateRangeLabel : '—'}</div>
          </div>

          {/* Time */}
          <div className={styles.summarySection}>
            <div className={styles.summaryLabel}>Time</div>
            <div className={styles.summaryValue}>{timeRangeLabel ?? '—'}</div>
          </div>

          {requiresApproval && (
            <div className={styles.approvalNotice}>
              One or more items require approval. Your booking will be submitted as Pending and reviewed before confirmation.
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
                      <span className={styles.conflictDetail}>Only {c.available} available</span>
                    )}
                    {c.reason === 'already_booked' && (
                      <span className={styles.conflictDetail}>Already booked</span>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          <button
            type="submit"
            className={styles.submitBtn}
            disabled={isPending || isCheckingConflict}
          >
            {isPending ? 'Saving\u2026' : 'CONFIRM BOOKING'}
          </button>
        </div>
      </div>
    </form>
  )
}
