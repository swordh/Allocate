/**
 * Shared domain fixtures for the test suite.
 *
 * Every factory's return type is annotated against the real types in `@/types`.
 * That annotation is the point of this file: it is what makes a future rename
 * of a domain union fail `tsc` instead of silently sending production code down
 * a different branch.
 *
 * This is not hypothetical. `TrackingType` was renamed from `'individual'` to
 * `'units'` and the fixtures were never updated. Because they were unannotated
 * object literals, nothing caught it, and `trackingType === 'units'` quietly
 * evaluated false everywhere — so tests named "individual-tracked equipment"
 * spent a year exercising the quantity branch instead.
 *
 * The shapes are the *stored Firestore document* shapes, so `id` is omitted
 * (it lives on the reference, not in the data) along with fields that are only
 * hydrated at query time.
 */

import type { Equipment, EquipmentUnit, Membership, Role, SessionClaims } from '@/types'

// ── Sessions ──────────────────────────────────────────────────────────────────

export const COMPANY_ID = 'company-abc'

export function makeSession(role: Role, overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    uid: `user-${role}`,
    email: `${role}@example.com`,
    activeCompanyId: COMPANY_ID,
    role,
    ...overrides,
  }
}

export const ADMIN_SESSION: SessionClaims = makeSession('admin')
export const CREW_SESSION: SessionClaims = makeSession('crew')
export const VIEWER_SESSION: SessionClaims = makeSession('viewer')

// ── Equipment ─────────────────────────────────────────────────────────────────

/** The stored shape of an equipment document. */
export type EquipmentDoc = Omit<Equipment, 'id' | 'units' | 'createdAt'>

/**
 * Unit-tracked equipment: one parent doc, one subcollection doc per physical
 * unit. `totalQuantity` is always 1 for these.
 */
export function makeUnitsEquipment(overrides: Partial<EquipmentDoc> = {}): EquipmentDoc {
  return {
    name: 'Camera A',
    description: null,
    category: 'Camera',
    active: true,
    trackingType: 'units',
    totalQuantity: 1,
    requiresApproval: false,
    approverId: null,
    availableForBooking: true,
    customFields: [],
    ...overrides,
  }
}

/** Quantity-tracked equipment: one doc represents a pool of interchangeable items. */
export function makeQuantityEquipment(overrides: Partial<EquipmentDoc> = {}): EquipmentDoc {
  return {
    ...makeUnitsEquipment(),
    name: 'Sandbag',
    category: 'Grip',
    trackingType: 'quantity',
    totalQuantity: 5,
    ...overrides,
  }
}

// ── Equipment units ───────────────────────────────────────────────────────────

export type EquipmentUnitDoc = Omit<EquipmentUnit, 'id' | 'createdAt'>

export function makeUnit(overrides: Partial<EquipmentUnitDoc> = {}): EquipmentUnitDoc {
  return {
    equipmentId: 'equip-1',
    companyId: COMPANY_ID,
    label: 'Unit 01',
    serialNumber: null,
    status: 'ok',
    notes: null,
    active: true,
    availableForBooking: true,
    ...overrides,
  }
}

// ── Memberships ───────────────────────────────────────────────────────────────

export function makeMembership(overrides: Partial<Membership> = {}): Membership {
  return {
    companyId: COMPANY_ID,
    role: 'admin',
    joinedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}
