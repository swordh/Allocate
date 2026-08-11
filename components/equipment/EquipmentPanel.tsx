'use client'

import Link from 'next/link'
import Sheet from '@/components/ui/Sheet'
import Button from '@/components/ui/Button'
import Chip from '@/components/ui/Chip'
import Field from '@/components/ui/Field'
import Input from '@/components/ui/Input'
import Textarea from '@/components/ui/Textarea'
import ToggleSwitch from '@/components/ui/ToggleSwitch'
import Glyph from '@/components/ui/Glyph'
import StatusDot from '@/components/ui/StatusDot'
import ErrorBanner from '@/components/ui/ErrorBanner'
import type { UnitBookingState } from '@/hooks/useUnitBookings'
import type { TrackingType } from '@/types'
import styles from './EquipmentPanel.module.css'

export type PanelState =
  | { kind: 'newType' }
  | { kind: 'type'; equipmentId: string; category: string }
  | { kind: 'unit'; mode: 'add' | 'edit'; equipmentId: string; unitId?: string }

export interface TypeDraft {
  name: string
  category: string
  description: string
  inactive: boolean
  /** Immutable after creation — only the newType panel offers a choice. */
  trackingType: TrackingType
  totalQuantity: number
}

export interface UnitDraft {
  label: string
  serialNumber: string
  /** false is INACTIVE: still listed here, gone from the booking form. */
  availableForBooking: boolean
  /** BROKEN: listed and shown red in the booking form, but not selectable. */
  needsRepair: boolean
  notes: string
}

export type PanelDraft = TypeDraft | UnitDraft

interface EquipmentPanelProps {
  panel: PanelState
  draft: PanelDraft
  categories: string[]
  canEdit: boolean
  busy: boolean
  error: string | null
  /** Only meaningful in unit mode. */
  unitBooking?: UnitBookingState | null
  onChange: (patch: Partial<TypeDraft> & Partial<UnitDraft>) => void
  onSave: () => void
  onDelete: () => void
  onClose: () => void
}

const EYEBROWS: Record<string, string> = {
  newType: 'NEW EQUIPMENT',
  type: 'EQUIPMENT',
  add: 'ADD UNIT',
  edit: 'EDIT UNIT',
}

export default function EquipmentPanel({
  panel,
  draft,
  categories,
  canEdit,
  busy,
  error,
  unitBooking,
  onChange,
  onSave,
  onDelete,
  onClose,
}: EquipmentPanelProps) {
  const isUnit = panel.kind === 'unit'
  const unitDraft = draft as UnitDraft
  const typeDraft = draft as TypeDraft

  const eyebrow = isUnit ? EYEBROWS[panel.mode] : EYEBROWS[panel.kind]
  const title = isUnit
    ? unitDraft.label || 'New unit'
    : typeDraft.name || (panel.kind === 'newType' ? 'New equipment' : '')

  const canDelete =
    canEdit && (panel.kind === 'type' || (panel.kind === 'unit' && panel.mode === 'edit'))
  const saveLabel =
    panel.kind === 'newType' ? 'CREATE' : panel.kind === 'unit' && panel.mode === 'add' ? 'ADD' : 'SAVE'

  const footer = canEdit ? (
    <>
      {canDelete && (
        <Button variant="danger" size="sm" onClick={onDelete} disabled={busy}>
          {panel.kind === 'type' ? 'DELETE EQUIPMENT' : 'DELETE'}
        </Button>
      )}
      <span className={styles.footerSpacer} />
      <Button variant="primary" size="sm" onClick={onSave} loading={busy}>
        {saveLabel}
      </Button>
    </>
  ) : (
    <>
      <span className={styles.readOnlyNote}>Only admins can edit inventory.</span>
      <span className={styles.footerSpacer} />
      <Button variant="secondary" size="sm" onClick={onClose}>
        CLOSE
      </Button>
    </>
  )

  return (
    <Sheet docked open onClose={onClose} eyebrow={eyebrow} title={title} footer={footer}>
      {/* The rhythm between fields lives here, not in Field: a label needs room
          above it or it reads as a caption for the control before it. */}
      <div className={styles.form}>
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {isUnit && (
        <>
          <Field label="UNIT ID" htmlFor="unit-label">
            <Input
              id="unit-label"
              value={unitDraft.label}
              onChange={(e) => onChange({ label: e.target.value })}
              placeholder="e.g. KMD-04"
              disabled={!canEdit || busy}
            />
          </Field>

          <Field label="S/N" htmlFor="unit-sn">
            <Input
              id="unit-sn"
              value={unitDraft.serialNumber}
              onChange={(e) => onChange({ serialNumber: e.target.value })}
              placeholder="Manufacturer serial number"
              disabled={!canEdit || busy}
            />
          </Field>

          {/* Both labels name what the switch turns ON, so the label never
              contradicts the knob. Only the hint changes with the state. */}
          <div className={styles.toggles}>
            <ToggleSwitch
              checked={unitDraft.availableForBooking}
              onChange={(checked) => onChange({ availableForBooking: checked })}
              label="Available for booking"
              hint={
                unitDraft.availableForBooking
                  ? 'Shows up in the booking form.'
                  : 'Hidden from the booking form.'
              }
              disabled={!canEdit || busy}
            />
            <ToggleSwitch
              checked={unitDraft.needsRepair}
              onChange={(checked) => onChange({ needsRepair: checked })}
              label="Broken"
              hint={
                unitDraft.needsRepair
                  ? 'Not available for booking'
                  : 'Nothing wrong with it.'
              }
              disabled={!canEdit || busy}
            />
          </div>

          {unitBooking?.out && (
            <Field label="CURRENTLY OUT ON">
              <div className={styles.bookingList}>
                <BookingRow
                  href={`/bookings/${unitBooking.out.id}`}
                  project={unitBooking.out.projectName}
                  status="CHECKED OUT"
                  detail={`DUE ${unitBooking.out.dueLabel}`}
                  tone="out"
                />
              </div>
            </Field>
          )}

          {unitBooking && unitBooking.upcoming.length > 0 && (
            <Field label="UPCOMING BOOKINGS">
              <div className={styles.bookingList}>
                {unitBooking.upcoming.map((booking) => (
                  <BookingRow
                    key={booking.id}
                    href={`/bookings/${booking.id}`}
                    project={booking.projectName}
                    status={booking.status === 'pending' ? 'PENDING' : 'CONFIRMED'}
                    detail={booking.rangeLabel}
                    tone="upcoming"
                  />
                ))}
              </div>
            </Field>
          )}

          <Field label="NOTE" htmlFor="unit-note">
            <Textarea
              id="unit-note"
              value={unitDraft.notes}
              onChange={(e) => onChange({ notes: e.target.value })}
              placeholder="Optional note"
              rows={3}
              disabled={!canEdit || busy}
            />
          </Field>
        </>
      )}

      {!isUnit && (
        <>
          <Field label="NAME" htmlFor="type-name">
            <Input
              id="type-name"
              value={typeDraft.name}
              onChange={(e) => onChange({ name: e.target.value })}
              placeholder="e.g. DJI Ronin 4D"
              disabled={!canEdit || busy}
            />
          </Field>

          {panel.kind === 'type' ? (
            <Field label="CATEGORY">
              <p className={styles.readOnlyValue}>{panel.category}</p>
            </Field>
          ) : (
            <Field label="CATEGORY">
              <div className={styles.chipWrap}>
                {categories.map((category) => (
                  <Chip
                    key={category}
                    active={typeDraft.category === category}
                    disabled={!canEdit || busy}
                    onClick={() => onChange({ category })}
                  >
                    {category}
                  </Chip>
                ))}
              </div>
            </Field>
          )}

          {panel.kind === 'newType' && (
            <>
              {/* trackingType is immutable after creation, so this choice exists
                  only here — an existing type never offers it. */}
              <Field
                label="TRACKING"
                helper={
                  typeDraft.trackingType === 'units'
                    ? 'Each physical item is tracked separately, with its own unit ID.'
                    : 'A pool of interchangeable items, tracked by count.'
                }
              >
                <div className={styles.chipWrap}>
                  <Chip
                    active={typeDraft.trackingType === 'units'}
                    disabled={busy}
                    onClick={() => onChange({ trackingType: 'units' })}
                  >
                    UNITS
                  </Chip>
                  <Chip
                    active={typeDraft.trackingType === 'quantity'}
                    disabled={busy}
                    onClick={() => onChange({ trackingType: 'quantity' })}
                  >
                    QUANTITY
                  </Chip>
                </div>
              </Field>

              {typeDraft.trackingType === 'quantity' && (
                <Field label="QUANTITY" htmlFor="type-quantity">
                  <Input
                    id="type-quantity"
                    type="number"
                    min={1}
                    value={typeDraft.totalQuantity}
                    onChange={(e) =>
                      onChange({ totalQuantity: Math.max(1, parseInt(e.target.value, 10) || 1) })
                    }
                    disabled={busy}
                  />
                </Field>
              )}
            </>
          )}

          <Field label="DESCRIPTION" htmlFor="type-description">
            <Textarea
              id="type-description"
              value={typeDraft.description}
              onChange={(e) => onChange({ description: e.target.value })}
              placeholder={
                panel.kind === 'newType' ? 'Optional description' : 'Shared notes for this equipment'
              }
              rows={3}
              disabled={!canEdit || busy}
            />
          </Field>

          {panel.kind === 'type' && (
            <ToggleSwitch
              checked={!typeDraft.inactive}
              onChange={(checked) => onChange({ inactive: !checked })}
              label="Available for booking"
              hint={
                typeDraft.inactive
                  ? 'Hidden from the booking form.'
                  : 'Shows up in the booking form.'
              }
              disabled={!canEdit || busy}
              className={styles.activeToggle}
            />
          )}
        </>
      )}
      </div>
    </Sheet>
  )
}

function BookingRow({
  href,
  project,
  status,
  detail,
  tone,
}: {
  href: string
  project: string
  status: string
  detail: string
  tone: 'out' | 'upcoming'
}) {
  return (
    <Link href={href} className={`${styles.bookingRow} ${styles[`booking_${tone}`]}`}>
      <span className={styles.bookingMain}>
        <span className={styles.bookingProject}>{project}</span>
        <span className={styles.bookingMeta}>
          <span className={styles.bookingStatus}>
            <StatusDot size={6} />
            {status}
          </span>
          <span>{detail}</span>
        </span>
      </span>
      <Glyph char="›" className={styles.bookingChevron} />
    </Link>
  )
}
