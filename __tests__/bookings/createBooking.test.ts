/**
 * Integration-style tests for createBooking.
 *
 * Firebase Admin (adminDb, adminAuth) and getVerifiedSession are mocked.
 * No network calls are made. Tests verify that the action returns the expected
 * shape and that the Firestore transaction logic enforces business rules.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('@/lib/firebase-admin', () => {
  const mockDb = {
    doc: vi.fn(),
    collection: vi.fn(),
    runTransaction: vi.fn(),
  }
  const mockAuth = {
    getUser: vi.fn().mockResolvedValue({ displayName: 'Test User', email: 'test@example.com' }),
  }
  return { adminDb: mockDb, adminAuth: mockAuth }
})

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: vi.fn(),
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { createBooking } from '@/actions/bookings'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID = 'company-abc'

const ADMIN_SESSION = {
  uid: 'user-admin',
  email: 'admin@example.com',
  activeCompanyId: COMPANY_ID,
  role: 'admin' as const,
}

const CREW_SESSION = {
  uid: 'user-crew',
  email: 'crew@example.com',
  activeCompanyId: COMPANY_ID,
  role: 'crew' as const,
}

const VIEWER_SESSION = {
  uid: 'user-viewer',
  email: 'viewer@example.com',
  activeCompanyId: COMPANY_ID,
  role: 'viewer' as const,
}

/** Build a FormData with sensible defaults for a valid booking request. */
function makeFormData(overrides: Record<string, string> = {}): FormData {
  // Use a date far enough in the future to pass the "today or future" guard.
  const fd = new FormData()
  fd.set('projectName', 'Test Project')
  fd.set('startDate', '2030-01-10')
  fd.set('endDate', '2030-01-15')
  fd.set('notes', '')
  fd.set('items', JSON.stringify([{ equipmentId: 'equip-1', quantity: 1 }]))
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v)
  return fd
}

/** Company doc with an active subscription and sensible limits. */
const ACTIVE_COMPANY_DATA = {
  subscription: {
    status: 'active',
    plan: 'basic',
    limits: { equipment: 50, users: 5 },
  },
}

/** A standard active equipment document. */
const ACTIVE_INDIVIDUAL_EQUIP = {
  name: 'Camera A',
  active: true,
  trackingType: 'individual',
  totalQuantity: 1,
  requiresApproval: false,
  approverId: null,
}

/**
 * Wire adminDb.runTransaction to call the provided callback with a transaction
 * context that returns predetermined snapshot data from tx.get().
 *
 * snapshotMap: { '<docPath>': snapshotData | null (null = not exists) }
 * querySnap: optional docs array for tx.get(query)
 */
function wireTransaction(
  snapshotMap: Record<string, Record<string, unknown> | null>,
  queryDocs: Array<{
    id: string
    data: Record<string, unknown>
  }> = [],
) {
  const newDocId = 'new-booking-id'

  const tx = {
    get: vi.fn().mockImplementation((refOrQuery: unknown) => {
      // If it has a path property it's a DocumentReference.
      const ref = refOrQuery as { path?: string }
      if (ref.path) {
        const data = snapshotMap[ref.path] ?? null
        return Promise.resolve({
          exists: data !== null,
          data: () => data,
          id: ref.path.split('/').pop(),
        })
      }
      // Otherwise treat as a Query.
      return Promise.resolve({
        docs: queryDocs.map((d) => ({
          id: d.id,
          data: () => d.data,
        })),
      })
    }),
    set: vi.fn(),
    update: vi.fn(),
  }

  vi.mocked(adminDb.runTransaction).mockImplementation(
    async (cb: (tx: unknown) => Promise<unknown>) => {
      await cb(tx)
    },
  )

  // db.doc() returns a stub with the path set so tx.get() can look it up.
  vi.mocked(adminDb.doc).mockImplementation((path: string) => ({
    path,
    id: path.split('/').pop(),
  } as never))

  // db.collection() returns a stub that supports .doc() for the new booking ref.
  vi.mocked(adminDb.collection).mockImplementation((path: string) => ({
    path,
    doc: vi.fn().mockReturnValue({ id: newDocId, path: `${path}/${newDocId}` }),
    where: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        get: vi.fn().mockResolvedValue({
          docs: queryDocs.map((d) => ({
            id: d.id,
            data: () => d.data,
          })),
        }),
      }),
    }),
  } as never))

  return { tx, newDocId }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createBooking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getVerifiedSession).mockResolvedValue(ADMIN_SESSION)
  })

  // ── Auth guards ────────────────────────────────────────────────────────────

  describe('auth guards', () => {
    it('returns Unauthorized when session role is viewer', async () => {
      vi.mocked(getVerifiedSession).mockResolvedValue(VIEWER_SESSION)

      const result = await createBooking(makeFormData())

      expect(result).toEqual({ error: 'Unauthorized' })
      expect(adminDb.runTransaction).not.toHaveBeenCalled()
    })

    it('allows crew members to create bookings', async () => {
      vi.mocked(getVerifiedSession).mockResolvedValue(CREW_SESSION)

      wireTransaction({
        [`companies/${COMPANY_ID}`]: ACTIVE_COMPANY_DATA,
        [`companies/${COMPANY_ID}/equipment/equip-1`]: ACTIVE_INDIVIDUAL_EQUIP,
        [`users/${CREW_SESSION.uid}`]: { name: 'Crew Member' },
      })

      const result = await createBooking(makeFormData())

      expect(result).not.toHaveProperty('error')
      expect(result).toHaveProperty('bookingId')
    })

    it('allows admin members to create bookings', async () => {
      wireTransaction({
        [`companies/${COMPANY_ID}`]: ACTIVE_COMPANY_DATA,
        [`companies/${COMPANY_ID}/equipment/equip-1`]: ACTIVE_INDIVIDUAL_EQUIP,
        [`users/${ADMIN_SESSION.uid}`]: { name: 'Admin User' },
      })

      const result = await createBooking(makeFormData())

      expect(result).not.toHaveProperty('error')
      expect(result).toHaveProperty('bookingId')
    })
  })

  // ── Input validation ───────────────────────────────────────────────────────

  describe('input validation', () => {
    it('rejects a missing project name', async () => {
      const result = await createBooking(makeFormData({ projectName: '' }))
      expect(result).toEqual({ error: 'Project name is required' })
    })

    it('rejects a project name longer than 200 characters', async () => {
      const result = await createBooking(makeFormData({ projectName: 'x'.repeat(201) }))
      expect(result).toEqual({ error: 'Project name must be 200 characters or fewer' })
    })

    it('rejects an invalid startDate format', async () => {
      const result = await createBooking(makeFormData({ startDate: '01/10/2030' }))
      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('startDate')
    })

    it('rejects endDate before startDate', async () => {
      const result = await createBooking(
        makeFormData({ startDate: '2030-06-10', endDate: '2030-06-01' }),
      )
      expect(result).toEqual({ error: 'End date must be on or after start date' })
    })

    it('rejects a startDate in the past', async () => {
      const result = await createBooking(
        makeFormData({ startDate: '2000-01-01', endDate: '2000-01-05' }),
      )
      expect(result).toEqual({ error: 'startDate must be today or a future date.' })
    })

    it('rejects notes longer than 2000 characters', async () => {
      const result = await createBooking(makeFormData({ notes: 'x'.repeat(2001) }))
      expect(result).toEqual({ error: 'Notes must be 2000 characters or fewer' })
    })

    it('rejects a booking with no items', async () => {
      const result = await createBooking(makeFormData({ items: JSON.stringify([]) }))
      // validateItems throws "must be a non-empty array" which propagates as an error.
      expect(result).toHaveProperty('error')
    })

    it('rejects items array exceeding 50 entries', async () => {
      const tooMany = Array.from({ length: 51 }, (_, i) => ({
        equipmentId: `equip-${i}`,
        quantity: 1,
      }))
      const result = await createBooking(makeFormData({ items: JSON.stringify(tooMany) }))
      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('50')
    })
  })

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('creates a booking and returns the new bookingId', async () => {
      const { newDocId } = wireTransaction({
        [`companies/${COMPANY_ID}`]: ACTIVE_COMPANY_DATA,
        [`companies/${COMPANY_ID}/equipment/equip-1`]: ACTIVE_INDIVIDUAL_EQUIP,
        [`users/${ADMIN_SESSION.uid}`]: { name: 'Admin User' },
      })

      const result = await createBooking(makeFormData())

      expect(result).toEqual({ bookingId: newDocId })
    })

    it('writes a confirmed booking when no approval is required', async () => {
      const { tx } = wireTransaction({
        [`companies/${COMPANY_ID}`]: ACTIVE_COMPANY_DATA,
        [`companies/${COMPANY_ID}/equipment/equip-1`]: ACTIVE_INDIVIDUAL_EQUIP,
        [`users/${ADMIN_SESSION.uid}`]: { name: 'Admin User' },
      })

      await createBooking(makeFormData())

      const setCall = vi.mocked(tx.set).mock.calls[0]
      expect(setCall).toBeDefined()
      const writtenData = setCall[1] as Record<string, unknown>
      expect(writtenData.status).toBe('confirmed')
      expect(writtenData.requiresApproval).toBe(false)
    })

    it('writes a pending booking when equipment requires approval', async () => {
      const { tx } = wireTransaction({
        [`companies/${COMPANY_ID}`]: ACTIVE_COMPANY_DATA,
        [`companies/${COMPANY_ID}/equipment/equip-1`]: {
          ...ACTIVE_INDIVIDUAL_EQUIP,
          requiresApproval: true,
          approverId: 'approver-user-id',
        },
        [`users/${ADMIN_SESSION.uid}`]: { name: 'Admin User' },
      })

      await createBooking(makeFormData())

      const setCall = vi.mocked(tx.set).mock.calls[0]
      const writtenData = setCall[1] as Record<string, unknown>
      expect(writtenData.status).toBe('pending')
      expect(writtenData.approvalStatus).toBe('pending')
      expect(writtenData.approverId).toBe('approver-user-id')
    })
  })

  // ── Conflict detection ─────────────────────────────────────────────────────

  describe('conflict path', () => {
    it('returns an error when conflict detection finds an overlap', async () => {
      // Wire the conflict: the equipment is individual and there is an
      // overlapping booking in the query results returned during the transaction.
      wireTransaction(
        {
          [`companies/${COMPANY_ID}`]: ACTIVE_COMPANY_DATA,
          [`companies/${COMPANY_ID}/equipment/equip-1`]: ACTIVE_INDIVIDUAL_EQUIP,
          [`users/${ADMIN_SESSION.uid}`]: { name: 'Admin User' },
        },
        [
          // This booking returned by tx.get(query) will trigger the conflict.
          {
            id: 'booking-conflict',
            data: {
              startDate: '2030-01-12',
              endDate: '2030-01-14',
              status: 'confirmed',
              approvalStatus: 'none',
              equipmentIds: ['equip-1'],
              items: [{ equipmentId: 'equip-1', quantity: 1 }],
            },
          },
        ],
      )

      const result = await createBooking(makeFormData())

      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('conflict')
    })
  })

  // ── Subscription enforcement ───────────────────────────────────────────────

  describe('subscription enforcement', () => {
    it('returns an error when subscription is cancelled', async () => {
      wireTransaction({
        [`companies/${COMPANY_ID}`]: {
          subscription: {
            status: 'canceled',
            plan: 'basic',
            limits: { equipment: 50, users: 5 },
          },
        },
      })

      const result = await createBooking(makeFormData())

      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('Subscription')
    })

    it('allows booking creation when subscription is trialing', async () => {
      wireTransaction({
        [`companies/${COMPANY_ID}`]: {
          subscription: {
            status: 'trialing',
            plan: 'basic',
            limits: { equipment: 50, users: 5 },
          },
        },
        [`companies/${COMPANY_ID}/equipment/equip-1`]: ACTIVE_INDIVIDUAL_EQUIP,
        [`users/${ADMIN_SESSION.uid}`]: { name: 'Admin User' },
      })

      const result = await createBooking(makeFormData())

      expect(result).toHaveProperty('bookingId')
    })
  })

  // ── Equipment validation inside transaction ────────────────────────────────

  describe('equipment validation', () => {
    it('returns an error when requested equipment does not exist', async () => {
      wireTransaction({
        [`companies/${COMPANY_ID}`]: ACTIVE_COMPANY_DATA,
        [`companies/${COMPANY_ID}/equipment/equip-1`]: null, // not found
      })

      const result = await createBooking(makeFormData())

      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('not found')
    })

    it('returns an error when equipment is deactivated', async () => {
      wireTransaction({
        [`companies/${COMPANY_ID}`]: ACTIVE_COMPANY_DATA,
        [`companies/${COMPANY_ID}/equipment/equip-1`]: {
          ...ACTIVE_INDIVIDUAL_EQUIP,
          active: false,
        },
      })

      const result = await createBooking(makeFormData())

      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('not available')
    })

    it('returns an error when quantity > 1 for individually tracked equipment', async () => {
      wireTransaction({
        [`companies/${COMPANY_ID}`]: ACTIVE_COMPANY_DATA,
        [`companies/${COMPANY_ID}/equipment/equip-1`]: ACTIVE_INDIVIDUAL_EQUIP,
      })

      const items = JSON.stringify([{ equipmentId: 'equip-1', quantity: 2 }])
      const result = await createBooking(makeFormData({ items }))

      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('quantity must be 1')
    })

    it('returns an error when requested quantity exceeds total stock for quantity-tracked equipment', async () => {
      wireTransaction({
        [`companies/${COMPANY_ID}`]: ACTIVE_COMPANY_DATA,
        [`companies/${COMPANY_ID}/equipment/equip-1`]: {
          name: 'Tripod',
          active: true,
          trackingType: 'quantity',
          totalQuantity: 3,
          requiresApproval: false,
          approverId: null,
        },
      })

      const items = JSON.stringify([{ equipmentId: 'equip-1', quantity: 5 }])
      const result = await createBooking(makeFormData({ items }))

      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('exceeds total stock')
    })
  })
})
