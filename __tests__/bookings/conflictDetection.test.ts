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

// ── Helpers ───────────────────────────────────────────────────────────────────

const COMPANY_ID = 'company-abc'
const SESSION = {
  uid: 'user-1',
  email: 'user@example.com',
  activeCompanyId: COMPANY_ID,
  role: 'admin' as const,
}

/** Build a minimal equipment document snapshot. */
function makeEquipSnap(
  exists: boolean,
  overrides: Partial<{
    name: string
    trackingType: 'individual' | 'quantity'
    totalQuantity: number
    active: boolean
  }> = {},
) {
  return {
    exists,
    data: () => ({
      name: 'Camera A',
      trackingType: 'individual',
      totalQuantity: 1,
      active: true,
      requiresApproval: false,
      approverId: null,
      ...overrides,
    }),
  }
}

/** Build a minimal booking query snapshot. */
function makeBookingsQuerySnap(
  docs: Array<{
    id: string
    startDate: string
    endDate: string
    status: string
    approvalStatus: string
    equipmentIds: string[]
    items: Array<{ equipmentId: string; quantity: number }>
  }>,
) {
  return {
    docs: docs.map((d) => ({
      id: d.id,
      data: () => ({
        startDate: d.startDate,
        endDate: d.endDate,
        status: d.status,
        approvalStatus: d.approvalStatus,
        equipmentIds: d.equipmentIds,
        items: d.items,
      }),
    })),
  }
}

// ── Shared mock wiring ────────────────────────────────────────────────────────

/**
 * Set up adminDb.doc() and adminDb.collection() so they return the supplied
 * snapshots. The production code calls:
 *   db.doc(`companies/${companyId}/equipment/${id}`).get()
 *   db.collection(`companies/${companyId}/bookings`)
 *     .where(...).where(...).get()
 */
function wireAdminDb(
  equipSnap: ReturnType<typeof makeEquipSnap>,
  bookingsQuerySnap: ReturnType<typeof makeBookingsQuerySnap>,
) {
  const mockWhere2 = { get: vi.fn().mockResolvedValue(bookingsQuerySnap) }
  const mockWhere1 = { where: vi.fn().mockReturnValue(mockWhere2) }
  const mockCollectionRef = { where: vi.fn().mockReturnValue(mockWhere1) }

  vi.mocked(adminDb.doc).mockReturnValue({
    get: vi.fn().mockResolvedValue(equipSnap),
  } as never)

  vi.mocked(adminDb.collection).mockReturnValue(mockCollectionRef as never)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('checkConflict / detectConflictsReadOnly', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getVerifiedSession).mockResolvedValue(SESSION)
  })

  // ── Individual-tracked equipment ───────────────────────────────────────────

  describe('individual-tracked equipment', () => {
    it('returns no conflict when there are no overlapping bookings', async () => {
      wireAdminDb(
        makeEquipSnap(true, { trackingType: 'individual' }),
        makeBookingsQuerySnap([]),
      )

      const result = await checkConflict(
        COMPANY_ID,
        '2026-06-01',
        '2026-06-05',
        [{ equipmentId: 'equip-1', quantity: 1 }],
      )

      expect(result.hasConflict).toBe(false)
      expect(result.conflicts).toHaveLength(0)
    })

    it('returns conflict when an active booking overlaps the requested window', async () => {
      wireAdminDb(
        makeEquipSnap(true, { name: 'Camera A', trackingType: 'individual' }),
        makeBookingsQuerySnap([
          {
            id: 'booking-existing',
            startDate: '2026-06-03',
            endDate: '2026-06-08',
            status: 'confirmed',
            approvalStatus: 'none',
            equipmentIds: ['equip-1'],
            items: [{ equipmentId: 'equip-1', quantity: 1 }],
          },
        ]),
      )

      const result = await checkConflict(
        COMPANY_ID,
        '2026-06-01',
        '2026-06-05',
        [{ equipmentId: 'equip-1', quantity: 1 }],
      )

      expect(result.hasConflict).toBe(true)
      expect(result.conflicts[0].equipmentId).toBe('equip-1')
      expect(result.conflicts[0].reason).toBe('already_booked')
    })

    it('ignores cancelled bookings when evaluating conflicts', async () => {
      wireAdminDb(
        makeEquipSnap(true, { trackingType: 'individual' }),
        makeBookingsQuerySnap([
          {
            id: 'booking-cancelled',
            startDate: '2026-06-03',
            endDate: '2026-06-08',
            status: 'cancelled',        // should be ignored
            approvalStatus: 'none',
            equipmentIds: ['equip-1'],
            items: [{ equipmentId: 'equip-1', quantity: 1 }],
          },
        ]),
      )

      const result = await checkConflict(
        COMPANY_ID,
        '2026-06-01',
        '2026-06-05',
        [{ equipmentId: 'equip-1', quantity: 1 }],
      )

      expect(result.hasConflict).toBe(false)
    })

    it('ignores rejected bookings when evaluating conflicts', async () => {
      wireAdminDb(
        makeEquipSnap(true, { trackingType: 'individual' }),
        makeBookingsQuerySnap([
          {
            id: 'booking-rejected',
            startDate: '2026-06-03',
            endDate: '2026-06-08',
            status: 'pending',
            approvalStatus: 'rejected', // should be ignored
            equipmentIds: ['equip-1'],
            items: [{ equipmentId: 'equip-1', quantity: 1 }],
          },
        ]),
      )

      const result = await checkConflict(
        COMPANY_ID,
        '2026-06-01',
        '2026-06-05',
        [{ equipmentId: 'equip-1', quantity: 1 }],
      )

      expect(result.hasConflict).toBe(false)
    })

    it('excludes the specified booking id from conflict evaluation', async () => {
      // Simulates an edit where the booking overlaps only with itself.
      wireAdminDb(
        makeEquipSnap(true, { trackingType: 'individual' }),
        makeBookingsQuerySnap([
          {
            id: 'booking-self',
            startDate: '2026-06-01',
            endDate: '2026-06-05',
            status: 'confirmed',
            approvalStatus: 'none',
            equipmentIds: ['equip-1'],
            items: [{ equipmentId: 'equip-1', quantity: 1 }],
          },
        ]),
      )

      const result = await checkConflict(
        COMPANY_ID,
        '2026-06-01',
        '2026-06-05',
        [{ equipmentId: 'equip-1', quantity: 1 }],
        'booking-self', // excludeBookingId
      )

      expect(result.hasConflict).toBe(false)
    })

    it('returns no conflict when existing booking ends the day before the new one starts (adjacent, non-overlapping)', async () => {
      // Booking ends 2026-06-04; new booking starts 2026-06-05.
      // The Firestore query uses endDate >= startDate, so this doc WILL be in
      // the query results (endDate '2026-06-04' >= startDate '2026-06-05' is FALSE).
      // The where clause filters it out before we see it — wire the query to return empty.
      wireAdminDb(
        makeEquipSnap(true, { trackingType: 'individual' }),
        makeBookingsQuerySnap([]),
      )

      const result = await checkConflict(
        COMPANY_ID,
        '2026-06-05',
        '2026-06-10',
        [{ equipmentId: 'equip-1', quantity: 1 }],
      )

      expect(result.hasConflict).toBe(false)
    })

    it('treats same-day start and end dates as a valid single-day booking with no conflict', async () => {
      wireAdminDb(
        makeEquipSnap(true, { trackingType: 'individual' }),
        makeBookingsQuerySnap([]),
      )

      const result = await checkConflict(
        COMPANY_ID,
        '2026-06-01',
        '2026-06-01', // same day
        [{ equipmentId: 'equip-1', quantity: 1 }],
      )

      expect(result.hasConflict).toBe(false)
    })

    it('returns conflict when same-day booking collides with another same-day booking', async () => {
      wireAdminDb(
        makeEquipSnap(true, { name: 'Camera A', trackingType: 'individual' }),
        makeBookingsQuerySnap([
          {
            id: 'booking-same-day',
            startDate: '2026-06-01',
            endDate: '2026-06-01',
            status: 'confirmed',
            approvalStatus: 'none',
            equipmentIds: ['equip-1'],
            items: [{ equipmentId: 'equip-1', quantity: 1 }],
          },
        ]),
      )

      const result = await checkConflict(
        COMPANY_ID,
        '2026-06-01',
        '2026-06-01',
        [{ equipmentId: 'equip-1', quantity: 1 }],
      )

      expect(result.hasConflict).toBe(true)
      expect(result.conflicts[0].reason).toBe('already_booked')
    })

    it('returns conflict for a non-existent equipment id', async () => {
      wireAdminDb(
        makeEquipSnap(false), // equipment does not exist
        makeBookingsQuerySnap([]),
      )

      const result = await checkConflict(
        COMPANY_ID,
        '2026-06-01',
        '2026-06-05',
        [{ equipmentId: 'ghost-equip', quantity: 1 }],
      )

      expect(result.hasConflict).toBe(true)
      expect(result.conflicts[0].reason).toBe('already_booked')
    })
  })

  // ── Quantity-tracked equipment ─────────────────────────────────────────────

  describe('quantity-tracked equipment', () => {
    it('returns no conflict when requested quantity is within available stock', async () => {
      wireAdminDb(
        makeEquipSnap(true, { trackingType: 'quantity', totalQuantity: 10 }),
        makeBookingsQuerySnap([
          {
            id: 'booking-existing',
            startDate: '2026-06-01',
            endDate: '2026-06-05',
            status: 'confirmed',
            approvalStatus: 'none',
            equipmentIds: ['equip-q'],
            items: [{ equipmentId: 'equip-q', quantity: 3 }],
          },
        ]),
      )

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
      wireAdminDb(
        makeEquipSnap(true, { name: 'Tripod', trackingType: 'quantity', totalQuantity: 5 }),
        makeBookingsQuerySnap([
          {
            id: 'booking-existing',
            startDate: '2026-06-01',
            endDate: '2026-06-05',
            status: 'confirmed',
            approvalStatus: 'none',
            equipmentIds: ['equip-q'],
            items: [{ equipmentId: 'equip-q', quantity: 4 }],
          },
        ]),
      )

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
      wireAdminDb(
        makeEquipSnap(true, { name: 'Light', trackingType: 'quantity', totalQuantity: 2 }),
        makeBookingsQuerySnap([
          {
            id: 'booking-full',
            startDate: '2026-06-01',
            endDate: '2026-06-10',
            status: 'confirmed',
            approvalStatus: 'none',
            equipmentIds: ['equip-q'],
            items: [{ equipmentId: 'equip-q', quantity: 2 }],
          },
        ]),
      )

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
      wireAdminDb(
        makeEquipSnap(true, { trackingType: 'quantity', totalQuantity: 8 }),
        makeBookingsQuerySnap([
          {
            id: 'b1',
            startDate: '2026-06-01', endDate: '2026-06-10',
            status: 'confirmed', approvalStatus: 'none',
            equipmentIds: ['equip-q'],
            items: [{ equipmentId: 'equip-q', quantity: 2 }],
          },
          {
            id: 'b2',
            startDate: '2026-06-03', endDate: '2026-06-08',
            status: 'confirmed', approvalStatus: 'none',
            equipmentIds: ['equip-q'],
            items: [{ equipmentId: 'equip-q', quantity: 2 }],
          },
          {
            id: 'b3',
            startDate: '2026-06-05', endDate: '2026-06-07',
            status: 'confirmed', approvalStatus: 'none',
            equipmentIds: ['equip-q'],
            items: [{ equipmentId: 'equip-q', quantity: 2 }],
          },
        ]),
      )

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
