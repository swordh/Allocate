import type { Equipment, EquipmentUnit } from '@/types'

/**
 * What the design calls a status is three fields in the data model:
 *
 *   status === 'needs_repair'            → BROKEN    (listed, shown red when booking, not selectable)
 *   availableForBooking === false        → INACTIVE  (listed, absent from the booking picker)
 *   in a booking with status checked_out → OUT       (derived, not stored)
 *
 * `active` is not in that list on purpose: active === false is the soft delete.
 * Deleted equipment leaves the list and the booking picker entirely but stays in
 * Firestore so historic bookings can still name it.
 */
export type UnitDisplayStatus = 'AVAILABLE' | 'INACTIVE' | 'BROKEN' | 'OUT'

/** The three states the panel's status control writes. OUT is derived, never picked. */
export type UnitEditableStatus = Exclude<UnitDisplayStatus, 'OUT'>

export const EDITABLE_STATUSES: UnitEditableStatus[] = ['AVAILABLE', 'INACTIVE', 'BROKEN']

export function unitDisplayStatus(unit: EquipmentUnit, isOut = false): UnitDisplayStatus {
  if (isOut) return 'OUT'
  return unitEditableStatus(unit)
}

export function unitEditableStatus(unit: EquipmentUnit): UnitEditableStatus {
  if (unit.status === 'needs_repair') return 'BROKEN'
  if (unit.availableForBooking === false) return 'INACTIVE'
  return 'AVAILABLE'
}

/** The two stored fields behind an editable status. */
export function unitStatusFields(status: UnitEditableStatus): {
  status: EquipmentUnit['status']
  availableForBooking: boolean
} {
  switch (status) {
    case 'BROKEN':
      // Booking-visible on purpose: a broken unit shows up red in the picker so
      // people can see it exists, it just can't be selected.
      return { status: 'needs_repair', availableForBooking: true }
    case 'INACTIVE':
      return { status: 'ok', availableForBooking: false }
    case 'AVAILABLE':
      return { status: 'ok', availableForBooking: true }
  }
}

/** Equipment types only carry the INACTIVE flag — no repair state at type level. */
export function isTypeInactive(equipment: Equipment): boolean {
  return equipment.availableForBooking === false
}
