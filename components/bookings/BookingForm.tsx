'use client'

import { useState, useMemo, useTransition, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createBooking, updateBooking, checkConflict, getBookedSummary } from '@/actions/bookings'
import { useToast } from '@/lib/toast-context'
import BookingCalendar from './BookingCalendar'
import type { Booking, Equipment } from '@/types'
import type { ConflictResult, BookedSummary } from '@/actions/bookings'
import styles from './BookingForm.module.css'

interface BookingFormProps {
  companyId: string
  equipment: Equipment[]
  defaultStartDate: string
  defaultEndDate: string
  timeSlotMinutes: number
  booking?: Booking
  bookingId?: string
}

interface SelectedItem {
  equipmentId: string
  unitId?: string
  quantity: number
}

// ── helpers ─────────────────────────────────────────────────────────────────

const MONTHS_SHORT = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']

function fromKey(k: string): Date {
  const [y, m, d] = k.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function fmtDate(k: string | null): string {
  if (!k) return ''
  const d = fromKey(k)
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`
}

function daysBetween(s: string, e: string): number {
  return Math.round((fromKey(e).getTime() - fromKey(s).getTime()) / 86400000) + 1
}

function generateTimeOptions(slotMinutes: number): string[] {
  const step = slotMinutes >= 60 ? 60 : slotMinutes
  const options: string[] = []
  for (let h = 6; h <= 23; h++) {
    for (let m = 0; m < 60; m += step) {
      options.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
    }
  }
  return options
}

function groupByCategory(equipment: Equipment[]): Map<string, Equipment[]> {
  const map = new Map<string, Equipment[]>()
  for (const item of equipment) {
    if (!map.has(item.category)) map.set(item.category, [])
    map.get(item.category)!.push(item)
  }
  return map
}

// ── sub-components ───────────────────────────────────────────────────────────

function AvailBadge({ available, total, hasDates }: { available: number; total: number; hasDates: boolean }) {
  const tone = available <= 0 ? 'none' : available <= Math.max(1, Math.floor(total * 0.34)) ? 'low' : 'ok'
  return (
    <span className={`${styles.avail} ${tone === 'none' ? styles.availNone : tone === 'low' ? styles.availLow : ''}`}>
      <i className={styles.availDot} />
      <b>{available}</b> available
      {hasDates && available < total && <span className={styles.availOf}> of {total}</span>}
    </span>
  )
}

function Stepper({ value, min = 0, max = 99, onChange }: { value: number; min?: number; max?: number; onChange: (n: number) => void }) {
  return (
    <div className={styles.stepper} onClick={(e) => e.stopPropagation()}>
      <button type="button" className={styles.stepBtn} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>–</button>
      <span className={styles.stepVal}>{value}</span>
      <button type="button" className={styles.stepBtn} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>+</button>
    </div>
  )
}

// ── main component ───────────────────────────────────────────────────────────

export default function BookingForm({
  companyId,
  equipment,
  defaultStartDate,
  defaultEndDate,
  timeSlotMinutes,
  booking,
  bookingId,
}: BookingFormProps) {
  const router = useRouter()
  const { showToast, dismissToast } = useToast()

  const initialItems: SelectedItem[] = booking
    ? booking.items.map((i) => ({ equipmentId: i.equipmentId, unitId: i.unitId, quantity: i.quantity }))
    : []

  // ── form state ──────────────────────────────────────────────────────────
  const [projectName, setProjectName] = useState(booking?.projectName ?? '')
  const [startDate, setStartDate]     = useState(booking?.startDate ?? defaultStartDate)
  const [endDate, setEndDate]         = useState(booking?.endDate ?? defaultEndDate)
  const [fullDay, setFullDay]         = useState(booking ? (!booking.startTime && !booking.endTime) : false)
  const [startTime, setStartTime]     = useState(booking ? (booking.startTime ?? '') : '08:00')
  const [endTime, setEndTime]         = useState(booking ? (booking.endTime ?? '') : '18:00')
  const [notes, setNotes]             = useState(booking?.notes ?? '')
  const [selectedItems, setSelectedItems] = useState<SelectedItem[]>(initialItems)

  // ── availability + conflict state ───────────────────────────────────────
  const [error, setError]                     = useState<string | null>(null)
  const [conflictResult, setConflictResult]   = useState<ConflictResult | null>(null)
  const [isCheckingConflict, setIsCheckingConflict] = useState(false)
  const [bookedSummary, setBookedSummary]     = useState<Record<string, BookedSummary> | null>(null)
  const [isLoadingAvailability, setIsLoadingAvailability] = useState(false)
  const [isPending, startTransition]          = useTransition()

  // ── accordion state ─────────────────────────────────────────────────────
  const bookableEquipment = useMemo(() => equipment.filter((e) => e.availableForBooking !== false), [equipment])
  const grouped = useMemo(() => groupByCategory(bookableEquipment), [bookableEquipment])
  const sortedCategories = useMemo(() => Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b)), [grouped])

  const [openCats, setOpenCats] = useState<Record<string, boolean>>(() => {
    const first = sortedCategories[0]?.[0]
    return first ? { [first]: true } : {}
  })

  // ── unit-chip open state ─────────────────────────────────────────────────
  const [unitOpen, setUnitOpen] = useState<Set<string>>(() => {
    const s = new Set<string>()
    initialItems.filter((i) => i.unitId).forEach((i) => s.add(i.equipmentId))
    return s
  })

  // ── time options ─────────────────────────────────────────────────────────
  const timeOptions = useMemo(() => generateTimeOptions(timeSlotMinutes), [timeSlotMinutes])

  // ── load availability on mount ──────────────────────────────────────────
  const effectiveStart = booking?.startDate ?? defaultStartDate
  const effectiveEnd   = booking?.endDate   ?? defaultEndDate

  useEffect(() => {
    if (!effectiveStart || !effectiveEnd) return
    setIsLoadingAvailability(true)
    getBookedSummary(companyId, effectiveStart, effectiveEnd, bookingId, booking?.startTime ?? null, booking?.endTime ?? null)
      .then(setBookedSummary)
      .finally(() => setIsLoadingAvailability(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── refresh on time change ───────────────────────────────────────────────
  useEffect(() => {
    if (!startDate || !endDate) return
    const eff = endDate < startDate ? startDate : endDate
    const st = fullDay ? null : (startTime || null)
    const et = fullDay ? null : (endTime || null)
    setIsLoadingAvailability(true)
    getBookedSummary(companyId, startDate, eff, bookingId, st, et)
      .then(setBookedSummary)
      .finally(() => setIsLoadingAvailability(false))
    if (selectedItems.length > 0) {
      setIsCheckingConflict(true)
      checkConflict(companyId, startDate, eff, selectedItems, bookingId, st, et)
        .then(setConflictResult)
        .finally(() => setIsCheckingConflict(false))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startTime, endTime, fullDay])

  // ── date change ──────────────────────────────────────────────────────────
  async function handleDateChange(newStart: string, newEnd: string | null) {
    const s = newStart
    const e = newEnd ?? newStart
    setStartDate(s)
    setEndDate(e)
    const st = fullDay ? null : (startTime || null)
    const et = fullDay ? null : (endTime || null)
    setIsLoadingAvailability(true)
    getBookedSummary(companyId, s, e, bookingId, st, et)
      .then(setBookedSummary)
      .finally(() => setIsLoadingAvailability(false))
    if (selectedItems.length > 0) {
      setIsCheckingConflict(true)
      try {
        const result = await checkConflict(companyId, s, e, selectedItems, bookingId, st, et)
        setConflictResult(result)
      } finally {
        setIsCheckingConflict(false)
      }
    }
  }

  // ── selection helpers ────────────────────────────────────────────────────
  const conflictIds = useMemo(() => {
    if (!conflictResult?.hasConflict) return new Set<string>()
    return new Set(conflictResult.conflicts.map((c) => c.equipmentId))
  }, [conflictResult])

  function getQuantity(id: string): number {
    return selectedItems.find((i) => i.equipmentId === id && !i.unitId)?.quantity ?? 0
  }

  function getSelectedUnitId(equipmentId: string): string | undefined {
    return selectedItems.find((i) => i.equipmentId === equipmentId && i.unitId)?.unitId
  }

  function setQuantity(id: string, qty: number) {
    setSelectedItems((prev) => {
      if (qty <= 0) return prev.filter((i) => !(i.equipmentId === id && !i.unitId))
      const exists = prev.some((i) => i.equipmentId === id && !i.unitId)
      if (exists) return prev.map((i) => (i.equipmentId === id && !i.unitId ? { ...i, quantity: qty } : i))
      return [...prev, { equipmentId: id, quantity: qty }]
    })
    setConflictResult(null)
  }

  function selectUnit(equipmentId: string, unitId: string) {
    setSelectedItems((prev) => {
      const without = prev.filter((i) => i.equipmentId !== equipmentId || !i.unitId)
      return [...without, { equipmentId, unitId, quantity: 1 }]
    })
    setConflictResult(null)
  }

  function deselectUnit(equipmentId: string) {
    setSelectedItems((prev) => prev.filter((i) => !(i.equipmentId === equipmentId && i.unitId)))
    setConflictResult(null)
  }

  function sortedUnits(eq: Equipment): NonNullable<typeof eq.units> {
    const bookable = (eq.units ?? []).filter((u) => u.availableForBooking !== false)
    const booked = new Set(bookedSummary?.[eq.id]?.unitIds ?? [])
    const available   = bookable.filter((u) => !booked.has(u.id)).sort((a, b) => a.label.localeCompare(b.label))
    const unavailable = bookable.filter((u) =>  booked.has(u.id)).sort((a, b) => a.label.localeCompare(b.label))
    return [...available, ...unavailable]
  }

  // ── full day toggle ──────────────────────────────────────────────────────
  function toggleFullDay() {
    if (!fullDay) {
      setStartTime('')
      setEndTime('')
    } else {
      setStartTime('08:00')
      setEndTime('18:00')
    }
    setFullDay(!fullDay)
  }

  // ── submit ───────────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (selectedItems.length === 0) {
      setError('Select at least one equipment item.')
      return
    }

    if (startDate && endDate) {
      const st = fullDay ? null : (startTime || null)
      const et = fullDay ? null : (endTime || null)
      const result = await checkConflict(companyId, startDate, endDate, selectedItems, bookingId, st, et)
      setConflictResult(result)
      if (result.hasConflict) {
        setError('Equipment is not available for the selected dates. Check conflicts below.')
        return
      }
    }

    const formData = new FormData()
    formData.set('projectName', projectName)
    formData.set('startDate', startDate)
    formData.set('endDate', endDate)
    if (!fullDay && startTime) formData.set('startTime', startTime)
    if (!fullDay && endTime)   formData.set('endTime', endTime)
    formData.set('notes', notes)
    formData.set('items', JSON.stringify(selectedItems))

    if (bookingId) {
      const toastId = showToast('saving', 'Saving changes...')
      startTransition(async () => {
        const result = await updateBooking(bookingId, formData)
        dismissToast(toastId)
        if (result.error) {
          setError(result.error)
          showToast('error', result.error, 5000)
        } else {
          showToast('success', 'Booking updated', 3000)
          router.push(`/bookings/${bookingId}`)
        }
      })
    } else {
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
  }

  // ── derived values ───────────────────────────────────────────────────────
  const itemCount = selectedItems.length
  const canCreate = !!projectName.trim() && !!startDate && !!endDate && itemCount > 0
  const hasDates  = !!startDate

  const dateHint = startDate
    ? fmtDate(startDate) +
      (endDate && endDate !== startDate ? ' → ' + fmtDate(endDate) : '') +
      ' · ' + daysBetween(startDate, endDate || startDate) +
      (daysBetween(startDate, endDate || startDate) === 1 ? ' day' : ' days')
    : null

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <div className={styles.main}>

        {/* Page head */}
        <div className={styles.pageHead}>
          <h1 className={styles.h1}>{bookingId ? 'EDIT BOOKING' : 'NEW BOOKING'}</h1>
          <div className={styles.rule} />
        </div>

        {error && <div className={styles.errorBanner}>{error}</div>}

        {/* 01 — PROJECT */}
        <section className={styles.section}>
          <div className={styles.secHead}>
            <h2 className={styles.secTitle}>PROJECT</h2>
          </div>
          <div className={styles.secBody}>
            <input
              className={styles.bigfield}
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Project name"
              maxLength={200}
              required
            />
          </div>
        </section>

        {/* 02 — DATES */}
        <section className={styles.section}>
          <div className={styles.secHead}>
            <h2 className={styles.secTitle}>DATES</h2>
            {dateHint && <span className={styles.secHint}>{dateHint}</span>}
          </div>
          <div className={styles.secBody}>
            <div className={styles.scheduleGrid}>
              <div className={styles.calWrap}>
                <BookingCalendar
                  start={startDate || null}
                  end={endDate || null}
                  onChange={(s, e) => handleDateChange(s, e)}
                />
              </div>
              <div className={styles.schedSide}>
                {/* Date readouts */}
                <div className={styles.dateRow}>
                  <div className={styles.datebox}>
                    <label className={styles.datelabel}>PICKUP</label>
                    <span className={startDate ? styles.dateVal : styles.dateValDim}>
                      {fmtDate(startDate) || '--'}
                    </span>
                  </div>
                  <div className={styles.datebox}>
                    <label className={styles.datelabel}>RETURN</label>
                    <span className={endDate ? styles.dateVal : styles.dateValDim}>
                      {fmtDate(endDate) || '--'}
                    </span>
                  </div>
                </div>

                {/* Full day toggle */}
                {timeSlotMinutes !== -1 && (
                  <div className={styles.fulldayRow}>
                    <button
                      type="button"
                      className={`${styles.check} ${fullDay ? styles.checkOn : ''}`}
                      onClick={toggleFullDay}
                    >
                      <span className={styles.checkBox}>
                        {fullDay && (
                          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                            <path d="M2 7L5 10L11 2.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="square" />
                          </svg>
                        )}
                      </span>
                      <span className={styles.checkLabel}>Full day</span>
                    </button>
                    <span className={styles.fulldayNote}>
                      {fullDay ? 'Booked for the full day' : 'Set specific times below'}
                    </span>
                  </div>
                )}

                {/* Time pickers */}
                {timeSlotMinutes !== -1 && !fullDay && (
                  <div className={styles.timeRow}>
                    <div className={styles.timebox}>
                      <label className={styles.datelabel}>PICKUP TIME</label>
                      <select
                        className={styles.timeSelect}
                        value={startTime}
                        onChange={(e) => setStartTime(e.target.value)}
                      >
                        <option value="">--:--</option>
                        {timeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div className={styles.timeSep}>→</div>
                    <div className={styles.timebox}>
                      <label className={styles.datelabel}>RETURN TIME</label>
                      <select
                        className={styles.timeSelect}
                        value={endTime}
                        onChange={(e) => setEndTime(e.target.value)}
                      >
                        <option value="">--:--</option>
                        {timeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* 03 — EQUIPMENT */}
        <section className={styles.section}>
          <div className={styles.secHead}>
            <h2 className={styles.secTitle}>EQUIPMENT</h2>
            {itemCount > 0 && (
              <span className={styles.secHint}>{itemCount} {itemCount === 1 ? 'item' : 'items'}</span>
            )}
            {(isCheckingConflict || isLoadingAvailability) && (
              <span className={styles.secChecking}>checking…</span>
            )}
            <span className={`${styles.secTag} ${!hasDates ? styles.secTagMuted : ''}`}>
              {hasDates ? `AVAILABILITY · ${fmtDate(startDate)}` : 'SELECT DATES FOR LIVE AVAILABILITY'}
            </span>
          </div>
          <div className={styles.secBody}>
            {bookableEquipment.length === 0 ? (
              <div className={styles.emptyMsg}>
                {equipment.length === 0
                  ? 'No equipment added. Add equipment on the equipment page.'
                  : 'No equipment available for booking right now.'}
              </div>
            ) : (
              <div className={styles.cats}>
                {sortedCategories.map(([cat, items]) => {
                  const isOpen = !!openCats[cat]
                  const selCount = items.reduce((n, it) => {
                    const qty = getQuantity(it.id)
                    const unitId = getSelectedUnitId(it.id)
                    return n + (qty > 0 || !!unitId ? 1 : 0)
                  }, 0)
                  return (
                    <div key={cat} className={`${styles.cat} ${isOpen ? styles.catOpen : ''}`}>
                      <button
                        type="button"
                        className={styles.catHead}
                        onClick={() => setOpenCats({ ...openCats, [cat]: !isOpen })}
                      >
                        <svg className={styles.catChev} width="11" height="7" viewBox="0 0 11 7" fill="none">
                          <path d="M1 1L5.5 5.5L10 1" stroke="currentColor" strokeWidth="1.7" />
                        </svg>
                        <span className={styles.catName}>{cat}</span>
                        <span className={styles.catMeta}>
                          {selCount > 0 && <em className={styles.catBadge}>{selCount}</em>}
                          <span className={styles.catCount}>{items.length}</span>
                        </span>
                      </button>
                      {isOpen && (
                        <div className={styles.catBody}>
                          {items.map((eq) => {
                            const hasConflict = conflictIds.has(eq.id)

                            if (eq.trackingType === 'units') {
                              const units = sortedUnits(eq)
                              const selectedUnitId = getSelectedUnitId(eq.id)
                              const isUnitOpen = unitOpen.has(eq.id)
                              const bookedUnitIds = new Set(bookedSummary?.[eq.id]?.unitIds ?? [])
                              const availableUnits = units.filter((u) => !bookedUnitIds.has(u.id))
                              const availCount = bookedSummary !== null ? availableUnits.length : units.length

                              return (
                                <div
                                  key={eq.id}
                                  className={`${styles.eq} ${selectedUnitId ? styles.eqActive : ''} ${hasConflict ? styles.eqConflict : ''}`}
                                >
                                  <div className={styles.eqMain}>
                                    <div className={styles.eqInfo}>
                                      <span className={styles.eqName}>{eq.name}</span>
                                    </div>
                                    <div className={styles.eqRight}>
                                      <AvailBadge
                                        available={availCount}
                                        total={units.length}
                                        hasDates={hasDates && bookedSummary !== null}
                                      />
                                      <button
                                        type="button"
                                        className={`${styles.unitToggle} ${selectedUnitId ? styles.unitToggleOn : ''}`}
                                        onClick={() => {
                                          const next = !isUnitOpen
                                          setUnitOpen((prev) => {
                                            const s = new Set(prev)
                                            if (next) s.add(eq.id); else s.delete(eq.id)
                                            return s
                                          })
                                        }}
                                      >
                                        {selectedUnitId ? `${1} SELECTED` : 'SELECT'}
                                        <svg
                                          width="10" height="6" viewBox="0 0 11 7" fill="none"
                                          style={{ transform: isUnitOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}
                                        >
                                          <path d="M1 1L5.5 5.5L10 1" stroke="currentColor" strokeWidth="1.6" />
                                        </svg>
                                      </button>
                                    </div>
                                  </div>
                                  {isUnitOpen && (
                                    <div className={styles.units}>
                                      {units.map((unit) => {
                                        const isBooked = bookedUnitIds.has(unit.id)
                                        const isOn = selectedUnitId === unit.id
                                        return (
                                          <button
                                            key={unit.id}
                                            type="button"
                                            disabled={isBooked && !isOn}
                                            className={`${styles.unitChip} ${isOn ? styles.unitChipOn : ''} ${isBooked && !isOn ? styles.unitChipBad : ''}`}
                                            onClick={() => isOn ? deselectUnit(eq.id) : selectUnit(eq.id, unit.id)}
                                          >
                                            <span className={styles.unitName}>{unit.label}</span>
                                            {unit.serialNumber && (
                                              <span className={styles.unitSn}>{unit.serialNumber}</span>
                                            )}
                                            <span className={styles.unitState}>
                                              {isBooked ? 'BOOKED' : isOn ? '✓' : '+'}
                                            </span>
                                          </button>
                                        )
                                      })}
                                    </div>
                                  )}
                                </div>
                              )
                            }

                            // quantity equipment
                            const qty = getQuantity(eq.id)
                            const qtyBooked = bookedSummary?.[eq.id]?.quantity ?? 0
                            const qtyAvail = Math.max(0, eq.totalQuantity - qtyBooked)
                            const displayAvail = bookedSummary !== null ? qtyAvail : eq.totalQuantity

                            return (
                              <div
                                key={eq.id}
                                className={`${styles.eq} ${qty > 0 ? styles.eqActive : ''} ${hasConflict ? styles.eqConflict : ''}`}
                              >
                                <div className={styles.eqMain}>
                                  <div className={styles.eqInfo}>
                                    <span className={styles.eqName}>{eq.name}</span>
                                  </div>
                                  <div className={styles.eqRight}>
                                    <AvailBadge
                                      available={displayAvail}
                                      total={eq.totalQuantity}
                                      hasDates={hasDates && bookedSummary !== null}
                                    />
                                    <Stepper
                                      value={qty}
                                      min={0}
                                      max={qtyAvail + qty}
                                      onChange={(n) => setQuantity(eq.id, n)}
                                    />
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {conflictResult?.hasConflict && (
              <div className={styles.conflictNotice}>
                <div className={styles.conflictTitle}>Conflicts found</div>
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
          </div>
        </section>

        {/* 04 — NOTES */}
        <section className={styles.section}>
          <div className={styles.secHead}>
            <h2 className={styles.secTitle}>NOTES</h2>
          </div>
          <div className={styles.secBody}>
            <textarea
              className={styles.notes}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Delivery details, crew, special handling…"
              maxLength={2000}
              rows={3}
            />
          </div>
        </section>

        <div className={styles.footSpacer} />
      </div>

      {/* Sticky action bar */}
      <div className={styles.actionbar}>
        <div className={styles.actionSummary}>
          {startDate
            ? <strong className={styles.asStrong}>{fmtDate(startDate)}{endDate && endDate !== startDate ? '–' + fmtDate(endDate) : ''}</strong>
            : <span className={styles.asDim}>No dates</span>
          }
          <i className={styles.asDiv} />
          <span>{itemCount} {itemCount === 1 ? 'item' : 'items'}</span>
        </div>
        <div className={styles.actionBtns}>
          <button type="button" className={styles.btnGhost} onClick={() => router.back()}>
            CANCEL
          </button>
          <button
            type="submit"
            className={`${styles.btnPrimary} ${!canCreate ? styles.btnDisabled : ''}`}
            disabled={!canCreate || isPending}
          >
            {isPending ? 'SAVING…' : bookingId ? 'UPDATE BOOKING' : 'CREATE BOOKING'}
          </button>
        </div>
      </div>
    </form>
  )
}
