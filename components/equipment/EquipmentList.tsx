'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useEquipment } from '@/hooks/useEquipment'
import { useCategories } from '@/hooks/useCategories'
import { useUnitBookings, type UnitBookingState } from '@/hooks/useUnitBookings'
import {
  createEquipment,
  updateEquipment,
  deactivateEquipment,
  createUnit,
  updateUnit,
  deactivateUnit,
} from '@/actions/equipment'
import { PageHeader } from '@/components/nav/PageHeader'
import Button from '@/components/ui/Button'
import Chip from '@/components/ui/Chip'
import Icon from '@/components/ui/Icon'
import Glyph from '@/components/ui/Glyph'
import Modal from '@/components/ui/Modal'
import ConfirmDialog from '@/components/ui/ConfirmDialog'
import EmptyState from '@/components/ui/EmptyState'
import EquipmentPanel, {
  type PanelDraft,
  type PanelState,
  type TypeDraft,
  type UnitDraft,
} from './EquipmentPanel'
import {
  isTypeInactive,
  unitDisplayStatus,
  unitStatusFields,
  type UnitDisplayStatus,
} from './equipment-status'
import type { Equipment, EquipmentUnit, Role } from '@/types'
import styles from './EquipmentList.module.css'

interface EquipmentListProps {
  companyId: string
  role: Role
  initialEquipment: Equipment[]
}

type StatusFilter = 'ALL' | 'OUT' | 'INACTIVE' | 'BROKEN'

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'ALL', label: 'ALL' },
  { key: 'OUT', label: 'OUT NOW' },
  { key: 'INACTIVE', label: 'INACTIVE' },
  { key: 'BROKEN', label: 'BROKEN' },
]

interface VisibleUnit {
  unit: EquipmentUnit
  status: UnitDisplayStatus
  booking: UnitBookingState | null
}

interface VisibleType {
  equipment: Equipment
  units: VisibleUnit[]
  available: number
  total: number
}

interface VisibleGroup {
  category: string
  types: VisibleType[]
  unitCount: number
}

function emptyTypeDraft(category: string): TypeDraft {
  return {
    name: '',
    category,
    description: '',
    inactive: false,
    trackingType: 'units',
    totalQuantity: 1,
  }
}

function typeDraftFrom(equipment: Equipment): TypeDraft {
  return {
    name: equipment.name,
    category: equipment.category,
    description: equipment.description ?? '',
    inactive: isTypeInactive(equipment),
    trackingType: equipment.trackingType,
    totalQuantity: equipment.totalQuantity,
  }
}

function unitDraftFrom(unit: EquipmentUnit | null): UnitDraft {
  if (!unit) {
    return { label: '', serialNumber: '', availableForBooking: true, needsRepair: false, notes: '' }
  }
  return {
    label: unit.label,
    serialNumber: unit.serialNumber ?? '',
    ...unitStatusFields(unit),
    notes: unit.notes ?? '',
  }
}

export default function EquipmentList({ companyId, role, initialEquipment }: EquipmentListProps) {
  // Real-time listener replaces the server-fetched initial data.
  // initialEquipment seeds the UI with SSR data while the listener connects.
  const { equipment: liveEquipment, loading, error } = useEquipment(companyId)
  const equipment = loading ? initialEquipment : liveEquipment

  const { unitBookings, quantityOnBooking } = useUnitBookings(companyId)
  const { categories } = useCategories(companyId)

  const canEdit = role === 'admin'

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<StatusFilter>('ALL')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [openTypeId, setOpenTypeId] = useState<string | null>(null)

  const [panel, setPanel] = useState<PanelState | null>(null)
  const [draft, setDraft] = useState<PanelDraft | null>(null)
  const [initialDraft, setInitialDraft] = useState<PanelDraft | null>(null)
  /** Where to go once the unsaved-changes prompt is answered. */
  const [pendingSwitch, setPendingSwitch] = useState<{ panel: PanelState | null; draft: PanelDraft | null } | null>(null)
  const [deletePrompt, setDeletePrompt] = useState(false)
  const [forcePrompt, setForcePrompt] = useState<{ count: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [panelError, setPanelError] = useState<string | null>(null)

  const categoryNames = useMemo(() => {
    const fromCategories = categories.map((c) => c.name)
    const fromEquipment = equipment.map((e) => e.category).filter(Boolean)
    return Array.from(new Set([...fromCategories, ...fromEquipment])).sort()
  }, [categories, equipment])

  // ── Panel plumbing ───────────────────────────────────────────────────────
  // draft vs initialDraft is the dirty check; every entry point goes through
  // switchPanel so an unsaved edit can never be dropped silently.

  const dirty = panel !== null && JSON.stringify(draft) !== JSON.stringify(initialDraft)

  function applyPanel(next: { panel: PanelState | null; draft: PanelDraft | null }) {
    setPanel(next.panel)
    setDraft(next.draft)
    setInitialDraft(next.draft)
    setPanelError(null)
  }

  function switchPanel(next: { panel: PanelState | null; draft: PanelDraft | null }) {
    if (dirty) {
      setPendingSwitch(next)
      return
    }
    applyPanel(next)
  }

  function openNewType() {
    switchPanel({
      panel: { kind: 'newType' },
      draft: emptyTypeDraft(categoryNames[0] ?? ''),
    })
  }

  function openTypePanel(item: Equipment) {
    switchPanel({
      panel: { kind: 'type', equipmentId: item.id, category: item.category },
      draft: typeDraftFrom(item),
    })
  }

  function openUnitPanel(item: Equipment, unit: EquipmentUnit | null) {
    switchPanel({
      panel: unit
        ? { kind: 'unit', mode: 'edit', equipmentId: item.id, unitId: unit.id }
        : { kind: 'unit', mode: 'add', equipmentId: item.id },
      draft: unitDraftFrom(unit),
    })
  }

  function closePanel() {
    switchPanel({ panel: null, draft: null })
  }

  // ?add=1 in the URL (from the mobile menu CTA) opens the create panel on mount.
  const searchParams = useSearchParams()
  const openOnMount = canEdit && searchParams.get('add') === '1'

  useEffect(() => {
    if (openOnMount) openNewType()
    // Mount-only: the CTA sets the param once, and re-running would fight the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openOnMount])

  useEffect(() => {
    const handler = () => openNewType()
    window.addEventListener('equipment:open-add', handler)
    return () => window.removeEventListener('equipment:open-add', handler)
  })

  // ── Saving ───────────────────────────────────────────────────────────────

  /** Returns true when the write succeeded. */
  async function save(): Promise<boolean> {
    if (!panel || !draft) return false

    setBusy(true)
    setPanelError(null)

    try {
      if (panel.kind === 'newType') {
        const d = draft as TypeDraft
        if (!d.name.trim()) {
          setPanelError('Name is required.')
          return false
        }
        if (!d.category) {
          setPanelError('Pick a category.')
          return false
        }
        const form = new FormData()
        form.set('name', d.name)
        form.set('category', d.category)
        form.set('description', d.description)
        form.set('trackingType', d.trackingType)
        form.set('totalQuantity', String(d.totalQuantity))
        const result = await createEquipment(form)
        if ('error' in result) {
          setPanelError(result.error)
          return false
        }
        return true
      }

      if (panel.kind === 'type') {
        const d = draft as TypeDraft
        if (!d.name.trim()) {
          setPanelError('Name is required.')
          return false
        }
        const form = new FormData()
        form.set('name', d.name)
        form.set('description', d.description)
        form.set('availableForBooking', String(!d.inactive))
        const result = await updateEquipment(panel.equipmentId, form)
        if (result.error) {
          setPanelError(result.error)
          return false
        }
        return true
      }

      const d = draft as UnitDraft
      if (!d.label.trim()) {
        setPanelError('Unit ID is required.')
        return false
      }
      const form = new FormData()
      form.set('label', d.label)
      form.set('serialNumber', d.serialNumber)
      form.set('notes', d.notes)
      form.set('status', d.needsRepair ? 'needs_repair' : 'ok')
      form.set('availableForBooking', String(d.availableForBooking))

      const result =
        panel.mode === 'add'
          ? await createUnit(panel.equipmentId, form)
          : await updateUnit(panel.equipmentId, panel.unitId!, form)

      if (result && 'error' in result) {
        setPanelError(result.error)
        return false
      }
      return true
    } finally {
      setBusy(false)
    }
  }

  async function onSave() {
    const ok = await save()
    if (ok) applyPanel({ panel: null, draft: null })
  }

  async function onSaveAndSwitch() {
    const next = pendingSwitch
    if (!next) return
    const ok = await save()
    if (!ok) return
    setPendingSwitch(null)
    applyPanel(next)
  }

  function onDiscardAndSwitch() {
    const next = pendingSwitch
    setPendingSwitch(null)
    if (next) applyPanel(next)
  }

  // ── Deleting ─────────────────────────────────────────────────────────────
  // Delete is the soft delete (active: false): gone from this list and from the
  // booking form, still in Firestore so old bookings can name it.

  async function runDelete(force: boolean) {
    if (!panel) return

    setBusy(true)
    setPanelError(null)

    try {
      if (panel.kind === 'type') {
        const result = await deactivateEquipment(panel.equipmentId, force)
        if ('requiresForce' in result) {
          setDeletePrompt(false)
          setForcePrompt({ count: result.affectedBookingCount })
          return
        }
        if ('error' in result) {
          setPanelError(result.error)
          setDeletePrompt(false)
          return
        }
      } else if (panel.kind === 'unit' && panel.unitId) {
        const result = await deactivateUnit(panel.equipmentId, panel.unitId, force)
        if (result && 'requiresForce' in result) {
          setDeletePrompt(false)
          setForcePrompt({ count: result.futureBookingCount })
          return
        }
        if (result && 'error' in result) {
          setPanelError(result.error)
          setDeletePrompt(false)
          return
        }
      }

      setDeletePrompt(false)
      setForcePrompt(null)
      applyPanel({ panel: null, draft: null })
    } finally {
      setBusy(false)
    }
  }

  async function adjustQuantity(item: Equipment, delta: number) {
    const next = item.totalQuantity + delta
    if (next < 1) return

    setBusy(true)
    try {
      const form = new FormData()
      form.set('totalQuantity', String(next))
      await updateEquipment(item.id, form)
    } finally {
      setBusy(false)
    }
  }

  // ── Filtering and grouping ───────────────────────────────────────────────

  const normalizedQuery = query.trim().toLowerCase()
  const filterActive = normalizedQuery !== '' || filter !== 'ALL'

  const groups: VisibleGroup[] = useMemo(() => {
    // Filter on the underlying fields, not on the display label. A unit that is
    // both checked out and broken shows as OUT — one label, by precedence — but
    // it still has to answer to the BROKEN filter.
    const unitMatchesFilter = ({ unit, booking }: VisibleUnit) => {
      switch (filter) {
        case 'ALL':      return true
        case 'OUT':      return !!booking?.out
        case 'BROKEN':   return unit.status === 'needs_repair'
        case 'INACTIVE': return unit.availableForBooking === false
      }
    }

    // A type carries its own state too: INACTIVE is the only one that exists at
    // type level. Quantity types have no units, so this is their only way in.
    const typeMatchesFilter = (item: Equipment) =>
      filter === 'ALL' || (filter === 'INACTIVE' && isTypeInactive(item))

    const byCategory = new Map<string, VisibleType[]>()

    for (const item of equipment) {
      const nameHit =
        normalizedQuery === '' || item.name.toLowerCase().includes(normalizedQuery)

      const allUnits: VisibleUnit[] = (item.units ?? []).map((unit) => {
        const booking = unitBookings.get(unit.id) ?? null
        return { unit, status: unitDisplayStatus(unit, !!booking?.out), booking }
      })

      const matchesQuery = ({ unit }: VisibleUnit) =>
        normalizedQuery === '' ||
        nameHit ||
        unit.label.toLowerCase().includes(normalizedQuery) ||
        (unit.serialNumber ?? '').toLowerCase().includes(normalizedQuery)

      // When the type itself is what matched, show all of it — the whole type is
      // inactive, not particular units.
      const typeHit = typeMatchesFilter(item)
      const units = allUnits.filter(
        (u) => (typeHit || unitMatchesFilter(u)) && matchesQuery(u),
      )

      const isQuantity = item.trackingType !== 'units'

      // A filter or a search hides everything it doesn't match, so the hits are
      // visible without opening anything.
      if (filterActive) {
        const keepOnTypeAlone = typeHit && nameHit
        if (!keepOnTypeAlone && units.length === 0) continue
      }

      const category = item.category || 'Uncategorized'
      const list = byCategory.get(category) ?? []
      const booked = quantityOnBooking.get(item.id) ?? 0
      list.push({
        equipment: item,
        units,
        available: isQuantity
          ? Math.max(0, item.totalQuantity - booked)
          : allUnits.filter((u) => u.status === 'AVAILABLE').length,
        total: isQuantity ? item.totalQuantity : allUnits.length,
      })
      byCategory.set(category, list)
    }

    return Array.from(byCategory.entries())
      .map(([category, types]) => ({
        category,
        types: types.sort((a, b) => a.equipment.name.localeCompare(b.equipment.name)),
        unitCount: types.reduce((sum, t) => sum + t.total, 0),
      }))
      .sort((a, b) => a.category.localeCompare(b.category))
  }, [equipment, unitBookings, quantityOnBooking, normalizedQuery, filter, filterActive])

  const totals = useMemo(() => {
    let types = 0
    let units = 0
    let available = 0

    for (const item of equipment) {
      types += 1
      if (item.trackingType !== 'units') {
        units += item.totalQuantity
        available += Math.max(0, item.totalQuantity - (quantityOnBooking.get(item.id) ?? 0))
        continue
      }
      for (const unit of item.units ?? []) {
        units += 1
        if (unitDisplayStatus(unit, !!unitBookings.get(unit.id)?.out) === 'AVAILABLE') available += 1
      }
    }

    return { types, units, available }
  }, [equipment, unitBookings, quantityOnBooking])

  // ── Render ───────────────────────────────────────────────────────────────

  if (error) {
    return (
      <div className={styles.errorState}>
        <p>Failed to load equipment. Please refresh the page.</p>
        {process.env.NODE_ENV === 'development' && (
          <p className={styles.errorDetail}>{error.message}</p>
        )}
      </div>
    )
  }

  const inventoryEmpty = equipment.length === 0
  const noMatches = !inventoryEmpty && groups.length === 0
  const activeUnitId = panel?.kind === 'unit' ? panel.unitId : undefined

  return (
    <>
      <PageHeader
        title="Equipment"
        size="compact"
        meta={`${totals.types} TYPES · ${totals.units} UNITS`}
        actions={
          canEdit ? (
            // Desktop only — on mobile the hamburger menu already carries this
            // action, and a second one crowds the title row.
            <Button
              variant="primary"
              size="sm"
              onClick={openNewType}
              className={styles.desktopOnlyAction}
            >
              NEW EQUIPMENT
            </Button>
          ) : (
            <Chip size="tag" interactive={false}>
              VIEW ONLY · {role.toUpperCase()}
            </Chip>
          )
        }
      />

      <div className={styles.toolbar}>
        <div className={styles.search}>
          <Icon name="search" size={14} className={styles.searchIcon} />
          <input
            className={styles.searchInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search equipment or unit ID"
            aria-label="Search equipment or unit ID"
          />
        </div>
        <div className={styles.filters}>
          {FILTERS.map((f) => (
            <Chip
              key={f.key}
              active={filter === f.key}
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
            >
              {f.label}
            </Chip>
          ))}
        </div>
      </div>

      {/* With nothing to select from, the panel column is dead width — the
          empty state takes the full row until there is a panel to show. */}
      <div className={styles.layout} data-full={inventoryEmpty && !panel ? '' : undefined}>
        <div className={styles.list}>
          {inventoryEmpty || noMatches ? (
            <EmptyState
              variant="framed"
              eyebrow={inventoryEmpty ? 'NO INVENTORY YET' : 'NO MATCHES'}
              heading={inventoryEmpty ? 'Add your first equipment' : 'Nothing matches that'}
              body={
                inventoryEmpty
                  ? 'Group gear into equipment types — cameras, lenses, lighting — then add the individual units you own. Everything you add here becomes bookable.'
                  : 'Try another name or unit ID, or clear the status filter.'
              }
              action={
                inventoryEmpty && canEdit ? (
                  <Button variant="primary" size="sm" onClick={openNewType}>
                    NEW EQUIPMENT
                  </Button>
                ) : undefined
              }
            />
          ) : (
            groups.map((group) => {
              const open = filterActive || !collapsed[group.category]
              return (
                <section key={group.category} className={styles.group}>
                  <button
                    type="button"
                    className={styles.groupHeader}
                    onClick={() =>
                      setCollapsed((prev) => ({ ...prev, [group.category]: open }))
                    }
                    aria-expanded={open}
                  >
                    {/* Rotation lives in the CSS module, not on Glyph's rotate
                        prop — that writes an inline transform that would beat
                        the open-state rule. */}
                    <Glyph
                      char="›"
                      className={`${styles.groupChevron} ${open ? styles.chevronOpen : ''}`}
                    />
                    <span className={styles.groupName}>{group.category}</span>
                    <span className={styles.groupCount}>
                      <b>{group.types.length}</b>
                      <span className={styles.groupCountWord}> TYPES</span>
                      {' · '}
                      <b>{group.unitCount}</b>
                      <span className={styles.groupCountWord}> UNITS</span>
                    </span>
                  </button>

                  {open && (
                    <div className={styles.types}>
                      {group.types.map((type) => (
                        <TypeRow
                          key={type.equipment.id}
                          type={type}
                          open={filterActive || openTypeId === type.equipment.id}
                          canEdit={canEdit}
                          busy={busy}
                          activeUnitId={activeUnitId}
                          quantityBooked={quantityOnBooking.get(type.equipment.id) ?? 0}
                          onToggle={() =>
                            setOpenTypeId((prev) =>
                              prev === type.equipment.id ? null : type.equipment.id,
                            )
                          }
                          onOpenType={() => openTypePanel(type.equipment)}
                          onOpenUnit={(unit) => openUnitPanel(type.equipment, unit)}
                          onAdjustQuantity={(delta) => adjustQuantity(type.equipment, delta)}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )
            })
          )}
        </div>

        <aside className={styles.panelColumn}>
          {panel && draft ? (
              <EquipmentPanel
                panel={panel}
                draft={draft}
                categories={categoryNames}
                canEdit={canEdit}
                busy={busy}
                error={panelError}
                unitBooking={activeUnitId ? unitBookings.get(activeUnitId) ?? null : null}
                onChange={(patch) => setDraft((prev) => ({ ...(prev as PanelDraft), ...patch }))}
                onSave={onSave}
                onDelete={() => setDeletePrompt(true)}
                onClose={closePanel}
              />
          ) : (
            !inventoryEmpty && (
              <div className={styles.panelPlaceholder}>
                <span className={styles.panelPlaceholderTitle}>No unit selected</span>
                <span className={styles.panelPlaceholderBody}>
                  Click a unit tag, or &ldquo;+ ADD UNIT&rdquo;, to view or edit its properties here.
                </span>
              </div>
            )
          )}
        </aside>
      </div>

      {/* Three-way prompt: ConfirmDialog only carries two actions. */}
      <Modal
        open={pendingSwitch !== null}
        onClose={() => setPendingSwitch(null)}
        title="Unsaved changes"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setPendingSwitch(null)} disabled={busy}>
              CANCEL
            </Button>
            <Button variant="danger" size="sm" onClick={onDiscardAndSwitch} disabled={busy}>
              DON&apos;T SAVE
            </Button>
            <Button variant="primary" size="sm" onClick={onSaveAndSwitch} loading={busy}>
              SAVE
            </Button>
          </>
        }
      >
        You have unsaved changes. What would you like to do?
      </Modal>

      <ConfirmDialog
        open={deletePrompt}
        title="Delete this?"
        body="It disappears from your inventory and from the booking form. Existing bookings keep their history."
        confirmLabel="DELETE"
        busy={busy}
        onConfirm={() => runDelete(false)}
        onCancel={() => setDeletePrompt(false)}
      />

      <ConfirmDialog
        open={forcePrompt !== null}
        title="Booked right now"
        body={
          forcePrompt
            ? `This is on ${forcePrompt.count} active booking${forcePrompt.count === 1 ? '' : 's'}. Delete it anyway?`
            : undefined
        }
        confirmLabel="DELETE ANYWAY"
        busy={busy}
        onConfirm={() => runDelete(true)}
        onCancel={() => setForcePrompt(null)}
      />
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

interface TypeRowProps {
  type: VisibleType
  open: boolean
  canEdit: boolean
  busy: boolean
  activeUnitId?: string
  quantityBooked: number
  onToggle: () => void
  onOpenType: () => void
  onOpenUnit: (unit: EquipmentUnit | null) => void
  onAdjustQuantity: (delta: number) => void
}

function TypeRow({
  type,
  open,
  canEdit,
  busy,
  activeUnitId,
  quantityBooked,
  onToggle,
  onOpenType,
  onOpenUnit,
  onAdjustQuantity,
}: TypeRowProps) {
  const { equipment: item, units, available, total } = type
  const isQuantity = item.trackingType !== 'units'
  const inactive = isTypeInactive(item)

  // One summary for both tracking types — a pool of 12 sandbags and a shelf of
  // 12 lenses answer the same question. What is out is already implied by the
  // count, and the OUT chips below name the actual units.
  const summary = (
    <>
      <b>
        {available}/{total}
      </b>{' '}
      AVAILABLE
    </>
  )

  return (
    <div className={styles.type} data-inactive={inactive || undefined}>
      <div className={styles.typeHeader}>
        <button type="button" className={styles.typeName} onClick={onOpenType}>
          <span className={styles.typeNameRow}>
            {item.name}
            {inactive && <span className={styles.typeBadge}>INACTIVE</span>}
            {isQuantity && <span className={styles.typeBadge}>QTY</span>}
          </span>
          {/* Desktop keeps this on the right of the row (see .typeToggle). */}
          <span className={styles.typeSummaryStacked}>{summary}</span>
        </button>
        <button
          type="button"
          className={styles.typeToggle}
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? `Collapse ${item.name}` : `Expand ${item.name}`}
        >
          <span className={styles.typeSummary}>{summary}</span>
          <Glyph
            char="›"
            className={`${styles.typeChevron} ${open ? styles.chevronOpen : ''}`}
          />
        </button>
      </div>

      {open && (
        <div className={styles.typeBody}>
          {isQuantity ? (
            <div className={styles.quantityRow}>
              <span className={styles.quantityLabel}>QUANTITY</span>
              <button
                type="button"
                className={styles.quantityStep}
                onClick={() => onAdjustQuantity(-1)}
                disabled={!canEdit || busy || item.totalQuantity <= 1}
                aria-label={`Decrease quantity of ${item.name}`}
              >
                –
              </button>
              <span className={styles.quantityValue}>{item.totalQuantity}</span>
              <button
                type="button"
                className={styles.quantityStep}
                onClick={() => onAdjustQuantity(1)}
                disabled={!canEdit || busy}
                aria-label={`Increase quantity of ${item.name}`}
              >
                +
              </button>
              <span className={styles.quantityBooked}>{quantityBooked} on booking</span>
            </div>
          ) : (
            <div className={styles.units}>
              {units.map(({ unit, status, booking }) => (
                <button
                  key={unit.id}
                  type="button"
                  className={`${styles.unitChip} ${styles[`unit_${status}`]}`}
                  data-active={activeUnitId === unit.id || undefined}
                  onClick={() => onOpenUnit(unit)}
                  title={unitTooltip(unit, status, booking)}
                >
                  {unit.label}
                </button>
              ))}
              {canEdit && (
                <button type="button" className={styles.addUnit} onClick={() => onOpenUnit(null)}>
                  + ADD UNIT
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function unitTooltip(
  unit: EquipmentUnit,
  status: UnitDisplayStatus,
  booking: UnitBookingState | null,
): string {
  const parts: string[] = []
  if (unit.serialNumber) parts.push(`S/N ${unit.serialNumber}`)
  parts.push(
    status === 'OUT' && booking?.out
      ? `OUT — ${booking.out.projectName} until ${booking.out.dueLabel}`
      : status,
  )
  if (unit.notes) parts.push(unit.notes)
  const next = booking?.upcoming[0]
  if (next) parts.push(`next: ${next.projectName} ${next.rangeLabel}`)
  return parts.join(' · ')
}
