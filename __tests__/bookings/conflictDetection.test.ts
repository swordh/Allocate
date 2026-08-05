/**
 * Conflict detection unit tests.
 *
 * detectConflictsReadOnly and detectConflictsInTransaction are private to
 * actions/bookings.ts. We exercise them through checkConflict, which delegates
 * directly to detectConflictsReadOnly and uses the identical filter logic.
 *
 * Firebase Admin and getVerifiedSession are fully mocked — no network calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock firebase-admin modules ───────────────────────────────────────────────
// Must be hoisted before any import that transitively requires firebase-admin.

vi.mock('@/lib/firebase-admin', () => {
  const mockDb = {
    doc: vi.fn(),
    collection: vi.fn(),
  }
  return { adminDb: mockDb, adminAuth: {} }
})

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: vi.fn(),
}))

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { checkConflict } from '@/actions/bookings'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'

import { wireDb, type DocMap, type QueryResolver } from '../helpers/firestore'
import {
  ADMIN_SESSION,
  COMPANY_ID,
  makeQuantityEquipment,
  makeUnit,
  makeUnitsEquipment,
  type EquipmentDoc,
  type EquipmentUnitDoc,
} from '../helpers/fixtures'

// ── Helpers ───────────────────────────────────────────────────────────────────

interface BookingInput {
  id: string
  startDate: string
  endDate: string
  status: string
  approvalStatus: string
  equipmentIds?: string[]
  unitIds?: string[]
  items?: Array<{ equipmentId: string; quantity: number; unitId?: string }>
}

function makeBooking(overrides: Partial<BookingInput> & { id: string }): BookingInput {
  return {
    startDate: '2026-06-03',
    endDate: '2026-06-08',
    status: 'confirmed',
    approvalStatus: 'none',
    equipmentIds: ['equip-1'],
    unitIds: [],
    items: [{ equipmentId: 'equip-1', quantity: 1 }],
    ...overrides,
  }
}

/**
 * Wire adminDb for the two paths detectConflictsReadOnly takes.
 *
 * Unit-tracked:
 *   db.doc('companies/{c}/equipment/{id}').get()
 *   db.doc('companies/{c}/equipment/{id}/units/{unitId}').get()
 *   db.collection('companies/{c}/bookings')
 *     .where('unitIds','array-contains',unitId).where('endDate','>=',start).get()
 *
 * Quantity-tracked: same, minus the unit read, filtering on equipmentIds.
 *
 * The booking query applies the same predicates Firestore would, so the
 * `endDate >= startDate` index boundary is genuinely exercised rather than
 * simulated by hand-wiring an empty result.
 */
function wire({
  equipment = {},
  units = {},
  bookings = [],
}: {
  /** Keyed by equipmentId. `null` means the document does not exist. */
  equipment?: Record<string, EquipmentDoc | null>
  /** Keyed by `equipmentId/unitId`. `null` means the document does not exist. */
  units?: Record<string, EquipmentUnitDoc | null>
  bookings?: BookingInput[]
} = {}) {
  const docs: DocMap = {}

  for (const [equipmentId, data] of Object.entries(equipment)) {
    docs[`companies/${COMPANY_ID}/equipment/${equipmentId}`] = data
  }
  for (const [key, data] of Object.entries(units)) {
    const [equipmentId, unitId] = key.split('/')
    docs[`companies/${COMPANY_ID}/equipment/${equipmentId}/units/${unitId}`] = data
  }

  const query: QueryResolver = (ctx) => {
    if (!ctx.path.endsWith('/bookings')) return []

    const unitId = ctx.filters.find((f) => f.field === 'unitIds' && f.op === 'array-contains')?.value
    const equipmentId = ctx.filters.find(
      (f) => f.field === 'equipmentIds' && f.op === 'array-contains',
    )?.value
    const endDateFrom = ctx.filters.find((f) => f.field === 'endDate' && f.op === '>=')?.value as
      | string
      | undefined

    return bookings
      .filter((b) => (unitId === undefined ? true : (b.unitIds ?? []).includes(unitId as string)))
      .filter((b) =>
        equipmentId === undefined ? true : (b.equipmentIds ?? []).includes(equipmentId as string),
      )
      .filter((b) => (endDateFrom === undefined ? true : b.endDate >= endDateFrom))
      .map((b) => ({
        id: b.id,
        data: {
          startDate: b.startDate,
          endDate: b.endDate,
          status: b.status,
          approvalStatus: b.approvalStatus,
          equipmentIds: b.equipmentIds ?? [],
          unitIds: b.unitIds ?? [],
          items: b.items ?? [],
        },
      }))
  }

  return wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('checkConflict / detectConflictsReadOnly', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getVerifiedSession).mockResolvedValue(ADMIN_SESSION)
  })

  // ── Unit-tracked equipment ─────────────────────────────────────────────────
  //
  // Conflict is per physical unit, not per equipment type. These tests drive
  // the `trackingType === 'units'` branch, which had no coverage at all until
  // the fixtures were corrected — they declared a `trackingType` value that no
  // longer exists, so every one of them silently ran the quantity branch.

  describe('unit-tracked equipment', () => {
    const EQUIP = { 'equip-1': makeUnitsEquipment({ name: 'Camera A' }) }
    const UNITS = { 'equip-1/unit-a': makeUnit({ label: 'Unit 01' }) }
    const ITEM = { equipmentId: 'equip-1', quantity: 1, unitId: 'unit-a' }

    it('returns no conflict when there are no overlapping bookings', async () => {
      wire({ equipment: EQUIP, units: UNITS })

      const result = await checkConflict(COMPANY_ID, '2026-06-01', '2026-06-05', [ITEM])

      expect(result.hasConflict).toBe(false)
      expect(result.conflicts).toHaveLength(0)
    })

    it('returns conflict when no unitId is supplied for unit-tracked equipment', async () => {
      wire({ equipment: EQUIP, units: UNITS })

      const result = await checkConflict(COMPANY_ID, '2026-06-01', '2026-06-05', [
        { equipmentId: 'equip-1', quantity: 1 }, // unitId omitted
      ])

      expect(result.hasConflict).toBe(true)
      expect(result.conflicts[0].equipmentId).toBe('equip-1')
      expect(result.conflicts[0].reason).toBe('already_booked')
    })

    it('returns conflict when the referenced unit does not exist', async () => {
      wire({ equipment: EQUIP, units: { 'equip-1/unit-a': null } })

      const result = await checkConflict(COMPANY_ID, '2026-06-01', '2026-06-05', [ITEM])

      expect(result.hasConflict).toBe(true)
      expect(result.conflicts[0].reason).toBe('already_booked')
    })

    it('returns conflict when the referenced unit is deactivated', async () => {
      wire({ equipment: EQUIP, units: { 'equip-1/unit-a': makeUnit({ active: false }) } })

      const result = await checkConflict(COMPANY_ID, '2026-06-01', '2026-06-05', [ITEM])

      expect(result.hasConflict).toBe(true)
      expect(result.conflicts[0].reason).toBe('already_booked')
    })

    it('returns conflict when another booking holds the same unit over the window', async () => {
      wire({
        equipment: EQUIP,
        units: UNITS,
        bookings: [makeBooking({ id: 'booking-existing', unitIds: ['unit-a'] })],
      })

      const result = await checkConflict(COMPANY_ID, '2026-06-01', '2026-06-05', [ITEM])

      expect(result.hasConflict).toBe(true)
      expect(result.conflicts[0].equipmentId).toBe('equip-1')
      expect(result.conflicts[0].reason).toBe('already_booked')
      // checkConflict deliberately maps the internal detail down to ConflictItem,
      // which carries no conflictingBookingId — the caller must not learn the id
      // of someone else's booking.
      expect(result.conflicts[0]).not.toHaveProperty('conflictingBookingId')
    })

    it('returns no conflict when the overlapping booking holds a different unit', async () => {
      // The whole point of unit tracking: two units of the same type are
      // independently bookable.
      wire({
        equipment: EQUIP,
        units: { ...UNITS, 'equip-1/unit-b': makeUnit({ label: 'Unit 02' }) },
        bookings: [makeBooking({ id: 'booking-other-unit', unitIds: ['unit-b'] })],
      })

      const result = await checkConflict(COMPANY_ID, '2026-06-01', '2026-06-05', [ITEM])

      expect(result.hasConflict).toBe(false)
    })

    it('ignores cancelled bookings when evaluating conflicts', async () => {
      wire({
        equipment: EQUIP,
        units: UNITS,
        bookings: [
          makeBooking({ id: 'booking-cancelled', unitIds: ['unit-a'], status: 'cancelled' }),
        ],
      })

      const result = await checkConflict(COMPANY_ID, '2026-06-01', '2026-06-05', [ITEM])

      expect(result.hasConflict).toBe(false)
    })

    it('ignores rejected bookings when evaluating conflicts', async () => {
      wire({
        equipment: EQUIP,
        units: UNITS,
        bookings: [
          makeBooking({
            id: 'booking-rejected',
            unitIds: ['unit-a'],
            status: 'pending',
            approvalStatus: 'rejected',
          }),
        ],
      })

      const result = await checkConflict(COMPANY_ID, '2026-06-01', '2026-06-05', [ITEM])

      expect(result.hasConflict).toBe(false)
    })

    it('excludes the specified booking id from conflict evaluation', async () => {
      // Simulates an edit where the booking overlaps only with itself.
      wire({
        equipment: EQUIP,
        units: UNITS,
        bookings: [
          makeBooking({
            id: 'booking-self',
            unitIds: ['unit-a'],
            startDate: '2026-06-01',
            endDate: '2026-06-05',
          }),
        ],
      })

      const result = await checkConflict(
        COMPANY_ID,
        '2026-06-01',
        '2026-06-05',
        [ITEM],
        'booking-self',
      )

      expect(result.hasConflict).toBe(false)
    })

    it('returns no conflict when the existing booking ends the day before this one starts', async () => {
      // endDate 2026-06-04 vs startDate 2026-06-05. The Firestore query filters
      // on endDate >= startDate, and the mock applies that same predicate, so
      // this genuinely exercises the boundary rather than assuming it.
      wire({
        equipment: EQUIP,
        units: UNITS,
        bookings: [
          makeBooking({
            id: 'booking-adjacent',
            unitIds: ['unit-a'],
            startDate: '2026-06-01',
            endDate: '2026-06-04',
          }),
        ],
      })

      const result = await checkConflict(COMPANY_ID, '2026-06-05', '2026-06-10', [ITEM])

      expect(result.hasConflict).toBe(false)
    })

    it('returns no conflict when the existing booking starts the day after this one ends', async () => {
      wire({
        equipment: EQUIP,
        units: UNITS,
        bookings: [
          makeBooking({
            id: 'booking-later',
            unitIds: ['unit-a'],
            startDate: '2026-06-11',
            endDate: '2026-06-15',
          }),
        ],
      })

      const result = await checkConflict(COMPANY_ID, '2026-06-05', '2026-06-10', [ITEM])

      expect(result.hasConflict).toBe(false)
    })

    it('treats same-day start and end dates as a valid single-day booking', async () => {
      wire({ equipment: EQUIP, units: UNITS })

      const result = await checkConflict(COMPANY_ID, '2026-06-01', '2026-06-01', [ITEM])

      expect(result.hasConflict).toBe(false)
    })

    it('returns conflict when a same-day booking collides with another same-day booking', async () => {
      wire({
        equipment: EQUIP,
        units: UNITS,
        bookings: [
          makeBooking({
            id: 'booking-same-day',
            unitIds: ['unit-a'],
            startDate: '2026-06-01',
            endDate: '2026-06-01',
          }),
        ],
      })

      const result = await checkConflict(COMPANY_ID, '2026-06-01', '2026-06-01', [ITEM])

      expect(result.hasConflict).toBe(true)
      expect(result.conflicts[0].reason).toBe('already_booked')
    })

    it('returns conflict for a non-existent equipment id', async () => {
      wire({ equipment: { 'ghost-equip': null } })

      const result = await checkConflict(COMPANY_ID, '2026-06-01', '2026-06-05', [
        { equipmentId: 'ghost-equip', quantity: 1 },
      ])

      expect(result.hasConflict).toBe(true)
      expect(result.conflicts[0].reason).toBe('already_booked')
    })
  })

  // ── Quantity-tracked equipment ─────────────────────────────────────────────

  describe('quantity-tracked equipment', () => {
    it('returns no conflict when requested quantity is within available stock', async () => {
      wire({
        equipment: { 'equip-q': makeQuantityEquipment({ totalQuantity: 10 }) },
        bookings: [
          makeBooking({
            id: 'booking-existing',
            startDate: '2026-06-01',
            endDate: '2026-06-05',
            equipmentIds: ['equip-q'],
            items: [{ equipmentId: 'equip-q', quantity: 3 }],
          }),
        ],
      })

      // 10 total - 3 booked = 7 available. Requesting 5 — should pass.
      const result = await checkConflict(
        COMPANY_ID,
        '2026-06-02',
        '2026-06-04',
        [{ equipmentId: 'equip-q', quantity: 5 }],
      )

      expect(result.hasConflict).toBe(false)
    })

    it('returns insufficient_quantity conflict when requested quantity exceeds available stock', async () => {
      wire({
        equipment: { 'equip-q': makeQuantityEquipment({ name: 'Tripod', totalQuantity: 5 }) },
        bookings: [
          makeBooking({
            id: 'booking-existing',
            startDate: '2026-06-01',
            endDate: '2026-06-05',
            equipmentIds: ['equip-q'],
            items: [{ equipmentId: 'equip-q', quantity: 4 }],
          }),
        ],
      })

      // 5 total - 4 booked = 1 available. Requesting 3 — should fail.
      const result = await checkConflict(
        COMPANY_ID,
        '2026-06-02',
        '2026-06-04',
        [{ equipmentId: 'equip-q', quantity: 3 }],
      )

      expect(result.hasConflict).toBe(true)
      expect(result.conflicts[0].reason).toBe('insufficient_quantity')
      expect(result.conflicts[0].requested).toBe(3)
      expect(result.conflicts[0].available).toBe(1)
    })

    it('returns conflict when booked quantity exactly fills all stock', async () => {
      wire({
        equipment: { 'equip-q': makeQuantityEquipment({ name: 'Light', totalQuantity: 2 }) },
        bookings: [
          makeBooking({
            id: 'booking-full',
            startDate: '2026-06-01',
            endDate: '2026-06-10',
            equipmentIds: ['equip-q'],
            items: [{ equipmentId: 'equip-q', quantity: 2 }],
          }),
        ],
      })

      const result = await checkConflict(
        COMPANY_ID,
        '2026-06-03',
        '2026-06-05',
        [{ equipmentId: 'equip-q', quantity: 1 }],
      )

      expect(result.hasConflict).toBe(true)
      expect(result.conflicts[0].available).toBe(0)
    })

    it('accumulates booked quantity across multiple overlapping confirmed bookings', async () => {
      // 3 bookings of quantity 2 each = 6 booked. Total = 8. Available = 2.
      // Requesting 3 — should fail.
      wire({
        equipment: { 'equip-q': makeQuantityEquipment({ totalQuantity: 8 }) },
        bookings: [
          makeBooking({
            id: 'b1', startDate: '2026-06-01', endDate: '2026-06-10',
            equipmentIds: ['equip-q'], items: [{ equipmentId: 'equip-q', quantity: 2 }],
          }),
          makeBooking({
            id: 'b2', startDate: '2026-06-03', endDate: '2026-06-08',
            equipmentIds: ['equip-q'], items: [{ equipmentId: 'equip-q', quantity: 2 }],
          }),
          makeBooking({
            id: 'b3', startDate: '2026-06-05', endDate: '2026-06-07',
            equipmentIds: ['equip-q'], items: [{ equipmentId: 'equip-q', quantity: 2 }],
          }),
        ],
      })

      const result = await checkConflict(
        COMPANY_ID,
        '2026-06-04',
        '2026-06-06',
        [{ equipmentId: 'equip-q', quantity: 3 }],
      )

      expect(result.hasConflict).toBe(true)
      expect(result.conflicts[0].available).toBe(2)
    })
  })

  // ── Guard: mismatched companyId ────────────────────────────────────────────

  describe('security guards', () => {
    it('returns empty result when caller companyId does not match session companyId', async () => {
      // No db mocking needed — the function short-circuits before calling Firestore.
      const result = await checkConflict(
        'different-company-id',
        '2026-06-01',
        '2026-06-05',
        [{ equipmentId: 'equip-1', quantity: 1 }],
      )

      expect(result.hasConflict).toBe(false)
      expect(result.conflicts).toHaveLength(0)
      expect(adminDb.doc).not.toHaveBeenCalled()
    })
  })

  // ── Input validation short-circuits ───────────────────────────────────────

  describe('invalid input handling', () => {
    it('returns no conflict for an invalid date format instead of throwing', async () => {
      const result = await checkConflict(
        COMPANY_ID,
        'not-a-date',
        '2026-06-05',
        [{ equipmentId: 'equip-1', quantity: 1 }],
      )

      expect(result.hasConflict).toBe(false)
      expect(adminDb.doc).not.toHaveBeenCalled()
    })

    it('returns no conflict when endDate is before startDate', async () => {
      const result = await checkConflict(
        COMPANY_ID,
        '2026-06-10',
        '2026-06-01', // end before start
        [{ equipmentId: 'equip-1', quantity: 1 }],
      )

      expect(result.hasConflict).toBe(false)
    })
  })
})
