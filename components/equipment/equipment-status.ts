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

/** The panel edits the two stored fields directly, one toggle each. */
export interface UnitStatusFields {
  availableForBooking: boolean
  needsRepair: boolean
}

export function unitStatusFields(unit: EquipmentUnit): UnitStatusFields {
  return {
    availableForBooking: unit.availableForBooking !== false,
    needsRepair: unit.status === 'needs_repair',
  }
}

export function unitDisplayStatus(unit: EquipmentUnit, isOut = false): UnitDisplayStatus {
  if (isOut) return 'OUT'
  if (unit.status === 'needs_repair') return 'BROKEN'
  if (unit.availableForBooking === false) return 'INACTIVE'
  return 'AVAILABLE'
}

/** Equipment types only carry the INACTIVE flag — no repair state at type level. */
export function isTypeInactive(equipment: Equipment): boolean {
  return equipment.availableForBooking === false
}
