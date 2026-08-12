'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Button from '@/components/ui/Button'
import Chip from '@/components/ui/Chip'
import ErrorBanner from '@/components/ui/ErrorBanner'
import Glyph from '@/components/ui/Glyph'
import Icon from '@/components/ui/Icon'
import Sheet from '@/components/ui/Sheet'
import Textarea from '@/components/ui/Textarea'
import ToggleSwitch from '@/components/ui/ToggleSwitch'
import { createBooking, updateBooking, checkConflict, getBookedSummary } from '@/actions/bookings'
import type { BookedSummary, ConflictResult } from '@/actions/bookings'
import { useToast } from '@/lib/toast-context'
import { useIsMobile } from '@/hooks/useIsMobile'
import { formatCompactRange, formatDayShort, formatDayFull, todayInTimezone } from '@/lib/dates'
import BookingRangeCalendar from './BookingRangeCalendar'
import type { Booking, Equipment, EquipmentUnit } from '@/types'
import styles from './BookingForm.module.css'

/** How long to sit still before re-checking availability. */
const AVAILABILITY_DEBOUNCE_MS = 400

interface SelectedItem {
  equipmentId: string
  unitId?: string
  quantity: number
}

interface BookingFormProps {
  companyId: string
  equipment: Equipment[]
  defaultStartDate: string
  defaultEndDate: string
  timeSlotMinutes: number
  timezone: string
  booking?: Booking
  bookingId?: string
}

/**
 * New / edit booking — screen 09.
 *
 * One responsive component, not two code paths (decision 11): the same state
 * and the same handlers drive both widths, and the only difference is that
 * mobile puts the dates and notes panels in a bottom Sheet instead of in the
 * column. `useIsMobile` picks the container; everything else is CSS.
 */
export default function BookingForm({
  companyId,
  equipment,
  defaultStartDate,
  defaultEndDate,
  timeSlotMinutes,
  timezone,
  booking,
  bookingId,
}: BookingFormProps) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const { showToast, dismissToast } = useToast()

  const today = useMemo(() => todayInTimezone(timezone), [timezone])

  // ── state ───────────────────────────────────────────────────────────────
  const [projectName, setProjectName] = useState(booking?.projectName ?? '')
  const [notes, setNotes] = useState(booking?.notes ?? '')

  const [pickup, setPickup] = useState(booking?.startDate ?? defaultStartDate ?? today)
  const [ret, setRet] = useState(booking?.endDate ?? defaultEndDate ?? today)
  const [picking, setPicking] = useState<'pickup' | 'ret'>('pickup')

  // -1 is the "Full Day" company preference: the whole time UI is off.
  const timesDisabled = timeSlotMinutes === -1
  const [fullDay, setFullDay] = useState(
    booking ? !booking.startTime && !booking.endTime : true,
  )
  const [pickupTime, setPickupTime] = useState(booking?.startTime || '08:00')
  const [retTime, setRetTime] = useState(booking?.endTime || '18:00')

  const [selectedItems, setSelectedItems] = useState<SelectedItem[]>(
    booking?.items.map((i) => ({ equipmentId: i.equipmentId, unitId: i.unitId, quantity: i.quantity })) ?? [],
  )

  const [query, setQuery] = useState('')
  const [showSelectedOnly, setShowSelectedOnly] = useState(false)
  const [catOpen, setCatOpen] = useState<Record<string, boolean>>({})
  const [unitsOpen, setUnitsOpen] = useState<Record<string, boolean>>({})

  const [bookedSummary, setBookedSummary] = useState<Record<string, BookedSummary> | null>(null)
  const [checkingAvail, setCheckingAvail] = useState(false)
  const [conflictResult, setConflictResult] = useState<ConflictResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [sheet, setSheet] = useState<'dates' | 'notes' | null>(null)

  const effectiveStartTime = fullDay || timesDisabled ? null : pickupTime || null
  const effectiveEndTime = fullDay || timesDisabled ? null : retTime || null

  // ── availability ────────────────────────────────────────────────────────
  // Every date or time change re-asks the server what is left. Debounced so
  // dragging across a range is one lookup, not one per day.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (!pickup || !ret) return
    setCheckingAvail(true)
    clearTimeout(debounceRef.current)

    debounceRef.current = setTimeout(() => {
      getBookedSummary(companyId, pickup, ret, bookingId, effectiveStartTime, effectiveEndTime)
        .then(setBookedSummary)
        .finally(() => setCheckingAvail(false))
    }, AVAILABILITY_DEBOUNCE_MS)

    return () => clearTimeout(debounceRef.current)
  }, [companyId, bookingId, pickup, ret, effectiveStartTime, effectiveEndTime])

  // ── equipment model ─────────────────────────────────────────────────────
  // availableForBooking === false is INACTIVE: hidden from this picker
  // entirely. A broken unit is a different thing — it stays listed so people
  // can see it exists, struck through and not selectable.
  const bookable = useMemo(
    () => equipment.filter((e) => e.active !== false && e.availableForBooking !== false),
    [equipment],
  )

  function unitsOf(eq: Equipment): EquipmentUnit[] {
    return (eq.units ?? []).filter((u) => u.availableForBooking !== false)
  }

  function blockedUnitIds(eq: Equipment): Set<string> {
    return new Set(bookedSummary?.[eq.id]?.unitIds ?? [])
  }

  function totalOf(eq: Equipment): number {
    return eq.trackingType === 'units' ? unitsOf(eq).length : eq.totalQuantity
  }

  function bookedOf(eq: Equipment): number {
    if (eq.trackingType === 'units') {
      const blocked = blockedUnitIds(eq)
      return unitsOf(eq).filter((u) => blocked.has(u.id) || u.status === 'needs_repair').length
    }
    return bookedSummary?.[eq.id]?.quantity ?? 0
  }

  function quantityOf(eq: Equipment): number {
    if (eq.trackingType === 'units') {
      return selectedItems.filter((i) => i.equipmentId === eq.id && i.unitId).length
    }
    return selectedItems.find((i) => i.equipmentId === eq.id && !i.unitId)?.quantity ?? 0
  }

  const totalItems = selectedItems.reduce((sum, i) => sum + i.quantity, 0)

  // ── selection ───────────────────────────────────────────────────────────
  function setQuantity(eq: Equipment, next: number) {
    const max = Math.max(0, totalOf(eq) - bookedOf(eq))
    const qty = Math.max(0, Math.min(max, next))
    setConflictResult(null)

    if (eq.trackingType === 'units') {
      // Unit-tracked equipment has no quantity of its own — the stepper picks
      // and releases units so every item stays valid for the server.
      const blocked = blockedUnitIds(eq)
      const free = unitsOf(eq).filter((u) => !blocked.has(u.id) && u.status !== 'needs_repair')
      const chosen = selectedItems.filter((i) => i.equipmentId === eq.id && i.unitId).map((i) => i.unitId!)

      if (qty > chosen.length) {
        const toAdd = free.filter((u) => !chosen.includes(u.id)).slice(0, qty - chosen.length)
        setSelectedItems((prev) => [
          ...prev,
          ...toAdd.map((u) => ({ equipmentId: eq.id, unitId: u.id, quantity: 1 })),
        ])
      } else if (qty < chosen.length) {
        const drop = new Set(chosen.slice(qty))
        setSelectedItems((prev) => prev.filter((i) => !(i.equipmentId === eq.id && i.unitId && drop.has(i.unitId))))
      }
      return
    }

    setSelectedItems((prev) => {
      if (qty <= 0) return prev.filter((i) => !(i.equipmentId === eq.id && !i.unitId))
      if (prev.some((i) => i.equipmentId === eq.id && !i.unitId)) {
        return prev.map((i) => (i.equipmentId === eq.id && !i.unitId ? { ...i, quantity: qty } : i))
      }
      return [...prev, { equipmentId: eq.id, quantity: qty }]
    })
  }

  function toggleUnit(eq: Equipment, unit: EquipmentUnit) {
    setConflictResult(null)
    setSelectedItems((prev) => {
      const exists = prev.some((i) => i.equipmentId === eq.id && i.unitId === unit.id)
      if (exists) return prev.filter((i) => !(i.equipmentId === eq.id && i.unitId === unit.id))
      return [...prev, { equipmentId: eq.id, unitId: unit.id, quantity: 1 }]
    })
  }

  // ── filtering ───────────────────────────────────────────────────────────
  const q = query.trim().toLowerCase()

  const categories = useMemo(() => {
    const byCategory = new Map<string, Equipment[]>()
    for (const eq of bookable) {
      const list = byCategory.get(eq.category)
      if (list) list.push(eq)
      else byCategory.set(eq.category, [eq])
    }

    return Array.from(byCategory.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, items]) => {
        let matching = items.filter(
          (eq) => !q || eq.name.toLowerCase().includes(q) || name.toLowerCase().includes(q),
        )
        if (showSelectedOnly) matching = matching.filter((eq) => quantityOf(eq) > 0)
        return { name, items: matching }
      })
      .filter((cat) => cat.items.length > 0)
    // quantityOf reads selectedItems, so the list has to recompute with it.
  }, [bookable, q, showSelectedOnly, selectedItems, bookedSummary])

  // Searching forces the matching categories open — a hit inside a collapsed
  // group is not a hit anyone can see.
  const forcedOpen = q.length > 0 || showSelectedOnly

  // ── submit ──────────────────────────────────────────────────────────────
  const hasName = projectName.trim().length > 0
  const ready = hasName && totalItems > 0
  const readyHint = !hasName
    ? 'Add a project name to continue'
    : 'Select at least one item to continue'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!ready) return

    const conflict = await checkConflict(
      companyId, pickup, ret, selectedItems, bookingId, effectiveStartTime, effectiveEndTime,
    )
    setConflictResult(conflict)
    if (conflict.hasConflict) {
      setError('Some equipment is no longer available for these dates.')
      return
    }

    const formData = new FormData()
    formData.set('projectName', projectName)
    formData.set('startDate', pickup)
    formData.set('endDate', ret)
    if (effectiveStartTime) formData.set('startTime', effectiveStartTime)
    if (effectiveEndTime) formData.set('endTime', effectiveEndTime)
    formData.set('notes', notes)
    formData.set('items', JSON.stringify(selectedItems))

    // 'saving' renders the design's blocking overlay with the spinner, so this
    // is the toast context rather than a second implementation of it.
    const toastId = showToast('saving', bookingId ? 'Saving changes…' : 'Booking is being created…')

    startTransition(async () => {
      const result = bookingId
        ? await updateBooking(bookingId, formData)
        : await createBooking(formData)

      dismissToast(toastId)

      if ('error' in result && result.error) {
        setError(result.error)
        showToast('error', result.error, 5000)
        return
      }

      showToast('success', bookingId ? 'Booking updated' : 'Booking created', 3000)
      router.push(bookingId ? `/bookings/${bookingId}` : `/bookings/${(result as { bookingId: string }).bookingId}`)
    })
  }

  // ── panels ──────────────────────────────────────────────────────────────
  const whenLabel = pickup === ret ? formatDayFull(pickup) : `${formatCompactRange(pickup, ret)} ${ret.slice(0, 4)}`
  const timeLabel = fullDay || timesDisabled ? 'Full day' : `${pickupTime} → ${retTime}`

  const readout = (
    <div className={styles.readout}>
      <div className={styles.dateCard}>
        <span className={styles.dateCardLabel}>PICKUP</span>
        <span className={styles.dateCardValue}>{formatDayShort(pickup)}</span>
      </div>
      <Glyph char="→" className={styles.arrow} />
      <div className={styles.dateCard}>
        <span className={styles.dateCardLabel}>RETURN</span>
        <span className={styles.dateCardValue}>{formatDayShort(ret)}</span>
      </div>
    </div>
  )

  const datesPanel = (
    <div className={styles.datesGrid}>
      {readout}

      <div className={styles.calendarCell}>
        <BookingRangeCalendar
          pickup={pickup}
          ret={ret}
          picking={picking}
          today={today}
          onChange={(next) => {
            setPickup(next.pickup)
            setRet(next.ret)
            setPicking(next.picking)
            setConflictResult(null)
          }}
        />
      </div>

      <div className={styles.datesSide}>
        {!timesDisabled && (
          <>
            <div className={styles.fullDayRow}>
              <ToggleSwitch checked={fullDay} onChange={setFullDay} label="Full day" />
              <span className={styles.fullDayHint}>
                {fullDay ? 'booked for the whole day' : 'set specific pickup & return times'}
              </span>
            </div>

            <div className={`${styles.times} ${fullDay ? styles.timesOff : ''}`}>
              <label className={styles.timeField}>
                <span className={styles.fieldLabel}>PICKUP TIME</span>
                <span className={styles.timeInputWrap}>
                  <input
                    type="time"
                    className={styles.timeInput}
                    value={fullDay ? '' : pickupTime}
                    step={timeSlotMinutes * 60}
                    disabled={fullDay}
                    onChange={(e) => e.target.value && setPickupTime(e.target.value)}
                  />
                  {fullDay && <span className={styles.timeDash}>—</span>}
                </span>
              </label>

              <label className={styles.timeField}>
                <span className={styles.fieldLabel}>RETURN TIME</span>
                <span className={styles.timeInputWrap}>
                  <input
                    type="time"
                    className={styles.timeInput}
                    value={fullDay ? '' : retTime}
                    step={timeSlotMinutes * 60}
                    disabled={fullDay}
                    onChange={(e) => e.target.value && setRetTime(e.target.value)}
                  />
                  {fullDay && <span className={styles.timeDash}>—</span>}
                </span>
              </label>
            </div>
          </>
        )}
      </div>
    </div>
  )

  const notesPanel = (
    <Textarea
      className={styles.notes}
      placeholder="Anything the crew should know…"
      value={notes}
      onChange={(e) => setNotes(e.target.value)}
      rows={4}
    />
  )

  return (
    <form className={styles.page} onSubmit={handleSubmit}>
      <header className={styles.header}>
        <button type="button" className={styles.back} onClick={() => router.back()} aria-label="Go back">
          <Glyph char="‹" />
        </button>
        <h1 className={styles.title}>{bookingId ? 'EDIT BOOKING' : 'NEW BOOKING'}</h1>
        <span className={styles.draft}>{bookingId ? 'EDITING' : 'DRAFT · NOT SAVED'}</span>
      </header>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <div className={styles.body}>
        <div className={styles.main}>
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>PROJECT</h2>
            <label className={styles.fieldLabel} htmlFor="projectName">
              PROJECT NAME <span className={styles.required}>*</span>
            </label>
            <input
              id="projectName"
              className={styles.projectInput}
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Project name"
              maxLength={200}
            />
          </section>

          {/* Mobile keeps dates and notes behind quick pills; the panels below
              are the same nodes, in a Sheet instead of in the column. */}
          {isMobile ? (
            <div className={styles.pills}>
              {/* Only the date and time pills scroll; the notes button is a
                  sibling outside that track, pinned to the right edge. */}
              <div className={styles.pillTrack}>
                <button type="button" className={styles.pill} onClick={() => setSheet('dates')}>
                  <Icon name="calendar" size={14} strokeWidth={2} className={styles.pillIcon} aria-hidden />
                  {pickup === ret ? formatDayShort(pickup) : formatCompactRange(pickup, ret)}
                </button>
                <button type="button" className={styles.pill} onClick={() => setSheet('dates')}>
                  <Icon name="schedule" size={14} strokeWidth={2} aria-hidden />
                  {timeLabel}
                </button>
              </div>

              <button
                type="button"
                className={`${styles.pillIconOnly} ${notes.trim() ? styles.pillHasNotes : ''}`}
                onClick={() => setSheet('notes')}
                aria-label="Notes"
              >
                <Icon name="note" size={16} strokeWidth={1.8} aria-hidden />
              </button>
            </div>
          ) : (
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>DATES</h2>
              {datesPanel}
            </section>
          )}

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>EQUIPMENT</h2>
              {checkingAvail && (
                <span className={styles.checking}>
                  <span className={styles.spinner} aria-hidden />
                  Checking availability…
                </span>
              )}
            </div>

            <div className={styles.searchRow}>
              <div className={styles.search}>
                <Icon name="search" size={16} strokeWidth={2} className={styles.searchIcon} aria-hidden />
                <input
                  className={styles.searchInput}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search equipment"
                  aria-label="Search equipment"
                />
                {query && (
                  <button type="button" className={styles.clear} onClick={() => setQuery('')} aria-label="Clear search">
                    ✕
                  </button>
                )}
              </div>

              <ToggleSwitch
                className={styles.selectedToggle}
                checked={showSelectedOnly}
                onChange={setShowSelectedOnly}
                label={totalItems > 0 ? `Show selected only · ${totalItems}` : 'No items selected yet'}
              />
            </div>

            {categories.map((cat) => {
              const open = forcedOpen || !!catOpen[cat.name]
              const catCount = cat.items.reduce((sum, eq) => sum + quantityOf(eq), 0)
              return (
                <div key={cat.name} className={styles.category}>
                  <button
                    type="button"
                    className={styles.categoryHead}
                    style={catCount > 0 ? { borderLeftColor: 'var(--accent)' } : undefined}
                    onClick={() => setCatOpen((prev) => ({ ...prev, [cat.name]: !open }))}
                    aria-expanded={open}
                  >
                    <span>{cat.name.toUpperCase()}</span>
                    <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} aria-hidden>▾</span>
                  </button>

                  {open && (
                    <div>
                      {cat.items.map((eq) => {
                        const total = totalOf(eq)
                        const booked = bookedOf(eq)
                        const available = Math.max(0, total - booked)
                        const qty = quantityOf(eq)
                        const soldOut = available === 0
                        const units = unitsOf(eq)
                        const hasUnits = eq.trackingType === 'units' && units.length > 0
                        const showUnits = hasUnits && !!unitsOpen[eq.id]
                        const blocked = blockedUnitIds(eq)
                        const conflicted = conflictResult?.conflicts.some((c) => c.equipmentId === eq.id)

                        const unitsToggle = hasUnits ? (
                          <Chip
                            className={styles.unitsBtn}
                            active={showUnits}
                            onClick={() => setUnitsOpen((p) => ({ ...p, [eq.id]: !showUnits }))}
                          >
                            {showUnits ? 'HIDE UNITS' : 'SELECT UNITS'}
                          </Chip>
                        ) : null

                        return (
                          <div key={eq.id}>
                            <div
                              className={styles.item}
                              style={qty > 0 ? { borderLeftColor: 'var(--accent)' } : undefined}
                            >
                              <div className={styles.itemMain}>
                                <span className={`${styles.itemName} ${soldOut ? styles.itemNameOff : ''}`}>
                                  {eq.name}
                                </span>
                                <span
                                  className={`${styles.avail} ${soldOut || conflicted ? styles.availNone : ''} ${
                                    checkingAvail ? styles.availChecking : ''
                                  }`}
                                >
                                  {checkingAvail
                                    ? 'Checking availability…'
                                    : soldOut
                                      ? 'FULLY BOOKED FOR THESE DATES'
                                      : `${available} of ${total} available`}
                                </span>
                                {isMobile && unitsToggle}
                              </div>

                              <div className={styles.itemActions}>
                                {!isMobile && unitsToggle}

                                <div className={styles.stepper}>
                                  <button
                                    type="button"
                                    className={styles.stepBtn}
                                    onClick={() => setQuantity(eq, qty - 1)}
                                    disabled={qty <= 0}
                                    aria-label={`Remove one ${eq.name}`}
                                  >
                                    −
                                  </button>
                                  <span className={`${styles.qty} ${qty > 0 ? styles.qtyOn : ''}`}>{qty}</span>
                                  <button
                                    type="button"
                                    className={styles.stepBtn}
                                    onClick={() => setQuantity(eq, qty + 1)}
                                    disabled={qty >= available}
                                    aria-label={`Add one ${eq.name}`}
                                  >
                                    +
                                  </button>
                                </div>
                              </div>
                            </div>

                            {showUnits && (
                              <div className={styles.units}>
                                {units.map((unit) => {
                                  const taken = blocked.has(unit.id) || unit.status === 'needs_repair'
                                  const picked = selectedItems.some(
                                    (i) => i.equipmentId === eq.id && i.unitId === unit.id,
                                  )
                                  return (
                                    <Chip
                                      key={unit.id}
                                      className={`${styles.unitChip} ${taken ? styles.unitTaken : ''}`}
                                      active={picked}
                                      disabled={taken}
                                      onClick={() => toggleUnit(eq, unit)}
                                    >
                                      {unit.label}
                                    </Chip>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}

            {categories.length === 0 && (
              <p className={styles.noResults}>
                {showSelectedOnly ? 'No items selected yet' : `No equipment matches "${query}"`}
              </p>
            )}
          </section>

          {!isMobile && (
            <section className={`${styles.section} ${styles.sectionLast}`}>
              <label className={styles.fieldLabel} htmlFor="notes">
                NOTES <span className={styles.optional}>(optional)</span>
              </label>
              {notesPanel}
            </section>
          )}
        </div>

        <aside className={styles.summary}>
          <p className={styles.summaryTitle}>SUMMARY</p>

          <div>
            <p className={styles.summaryLabel}>PROJECT</p>
            <p className={`${styles.summaryValue} ${hasName ? '' : styles.summaryPlaceholder}`}>
              {hasName ? projectName : 'Untitled project'}
            </p>
          </div>

          <div>
            <p className={styles.summaryLabel}>WHEN</p>
            <p className={styles.summaryValue}>{whenLabel}</p>
            <p className={styles.summaryHint}>{timeLabel}</p>
          </div>

          <div className={styles.divider} />

          <div className={styles.actions}>
            <Button type="submit" fullWidth disabled={!ready || isPending}>
              {bookingId ? 'SAVE CHANGES' : 'CREATE BOOKING'}
            </Button>
            <Button type="button" variant="secondary" size="sm" fullWidth onClick={() => router.back()}>
              CANCEL
            </Button>
            {!ready && <p className={styles.readyHint}>{readyHint}</p>}
          </div>
        </aside>
      </div>

      {/* Mobile action bar — the toggle doubles as the way to review what is
          selected, which is why there is no separate cart (design decision). */}
      <div className={styles.mobileBar}>
        <ToggleSwitch
          className={styles.mobileToggle}
          checked={showSelectedOnly}
          onChange={setShowSelectedOnly}
          label={totalItems > 0 ? `Show selected only · ${totalItems}` : 'No items selected yet'}
        />
        <Button type="submit" disabled={!ready || isPending}>
          {bookingId ? 'SAVE' : 'CREATE'}
        </Button>
      </div>

      <Sheet
        open={sheet === 'dates'}
        onClose={() => setSheet(null)}
        title="Dates & time"
        dismissLabel="DONE"
      >
        {datesPanel}
      </Sheet>

      <Sheet open={sheet === 'notes'} onClose={() => setSheet(null)} title="Notes" dismissLabel="DONE">
        {notesPanel}
      </Sheet>
    </form>
  )
}
