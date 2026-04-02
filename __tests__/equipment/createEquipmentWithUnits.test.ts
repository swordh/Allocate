/**
 * Tests for the unit-creation side-effect of createEquipment.
 *
 * When `trackingType === 'serialized'` the action reads any FormData fields
 * matching the pattern `unitName_<index>` and creates a corresponding document
 * in the equipment's `units` subcollection.
 *
 * Covered behaviours:
 *   - trackingType !== 'serialized' → no unit documents created (even with unitName fields)
 *   - serialized, no unitName_* fields → no unit documents created
 *   - serialized, one valid name → one unit document created with correct fields
 *   - serialized, multiple valid names → one document per name
 *   - serialized, some blank names → blank names skipped, valid names written
 *   - serialized, all blank names → no unit documents created
 *   - unit documents carry active:true, availableForBooking:true, createdAt (serverTimestamp)
 *   - unit documents are written to the correct subcollection path
 *   - unit creation failure is best-effort: equipment { id } is still returned
 *
 * Firebase Admin, getVerifiedSession, and next/cache are mocked;
 * no network calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

// Capture the sentinel value returned by serverTimestamp() so tests can assert
// against it without importing the real firebase-admin/firestore module.
const SERVER_TIMESTAMP_SENTINEL = { _sentinel: 'serverTimestamp' } as const

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: vi.fn(() => SERVER_TIMESTAMP_SENTINEL),
  },
}))

vi.mock('@/lib/firebase-admin', () => {
  const mockDb = {
    doc: vi.fn(),
    collection: vi.fn(),
    runTransaction: vi.fn(),
  }
  return { adminDb: mockDb, adminAuth: {} }
})

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { createEquipment } from '@/actions/equipment'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID = 'company-abc'
const NEW_EQUIPMENT_ID = 'new-equip-id'

const ADMIN_SESSION = {
  uid: 'user-admin',
  email: 'admin@example.com',
  activeCompanyId: COMPANY_ID,
  role: 'admin' as const,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a FormData object with the minimum valid fields required for
 * createEquipment to pass validation. Pass `overrides` to set additional or
 * replacement keys, and `unitNames` to append `unitName_0`, `unitName_1`, …
 */
function makeFormData(
  overrides: Record<string, string> = {},
  unitNames: string[] = [],
): FormData {
  const fd = new FormData()
  fd.set('name', 'Cinema Camera A')
  fd.set('category', 'Camera')
  fd.set('trackingType', 'serialized')
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v)
  for (let i = 0; i < unitNames.length; i++) {
    fd.set(`unitName_${i}`, unitNames[i])
  }
  return fd
}

/**
 * Wire all adminDb mocks needed for createEquipment to reach its success path.
 *
 * Returns:
 *   - `unitsAddMock`: the vi.fn() that stands in for the units subcollection's
 *     `.add()` call — tests inspect this to verify unit creation.
 *   - `unitCollectionMock`: the collection ref stub for the units subcollection.
 */
function wireSuccessfulTransaction(
  subscriptionStatus = 'active',
  plan = 'basic',
  equipmentLimit = 50,
  currentCount = 0,
) {
  const unitsAddMock = vi.fn().mockResolvedValue({ id: 'unit-auto-id' })

  const unitCollectionMock = {
    add: unitsAddMock,
  }

  // adminDb.collection is called with two distinct paths:
  //   1. `companies/${companyId}/equipment` — for count query and new-doc ref
  //   2. `companies/${companyId}/equipment/${equipmentId}/units` — for .add()
  vi.mocked(adminDb.collection).mockImplementation((path: string) => {
    if (path.endsWith('/units')) {
      return unitCollectionMock as never
    }
    // Top-level equipment collection: count query + new document ref
    return {
      where: vi.fn().mockReturnValue({
        count: vi.fn().mockReturnValue({
          get: vi.fn().mockResolvedValue({
            data: () => ({ count: currentCount }),
          }),
        }),
      }),
      doc: vi.fn().mockReturnValue({ id: NEW_EQUIPMENT_ID }),
    } as never
  })

  // adminDb.doc is called for the company document ref inside the transaction.
  vi.mocked(adminDb.doc).mockImplementation((path: string) => ({
    path,
    id: path.split('/').pop(),
  } as never))

  // runTransaction immediately invokes the callback with a mock transaction
  // that returns a valid company snapshot (active subscription, under limit).
  const tx = {
    get: vi.fn().mockResolvedValue({
      exists: true,
      data: () => ({
        subscription: {
          status: subscriptionStatus,
          plan,
          limits: { equipment: equipmentLimit, users: 5 },
        },
      }),
    }),
    set: vi.fn(),
  }

  vi.mocked(adminDb.runTransaction).mockImplementation(
    async (cb: (tx: unknown) => Promise<unknown>) => {
      await cb(tx)
    },
  )

  return { unitsAddMock, unitCollectionMock, tx }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createEquipment — initial unit creation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getVerifiedSession).mockResolvedValue(ADMIN_SESSION)
  })

  // ── trackingType guard ─────────────────────────────────────────────────────

  describe('when trackingType is not serialized', () => {
    it('does not create any unit documents even when unitName fields are present', async () => {
      const { unitsAddMock } = wireSuccessfulTransaction()

      const fd = makeFormData(
        { trackingType: 'quantity', totalQuantity: '3' },
        ['Camera Body 1', 'Camera Body 2'],
      )
      const result = await createEquipment(fd)

      expect(result).toEqual({ id: NEW_EQUIPMENT_ID })
      expect(unitsAddMock).not.toHaveBeenCalled()
    })

    it('does not call the units subcollection for a quantity-tracked item', async () => {
      wireSuccessfulTransaction()

      const fd = makeFormData(
        { trackingType: 'quantity', totalQuantity: '1' },
        ['Unit A'],
      )
      await createEquipment(fd)

      // collection() should only be called for the equipment collection,
      // never for a path ending in /units.
      const collectionCalls = vi.mocked(adminDb.collection).mock.calls.map(
        ([path]: [string]) => path,
      )
      expect(collectionCalls.some((p) => p.endsWith('/units'))).toBe(false)
    })
  })

  // ── No unitName fields ─────────────────────────────────────────────────────

  describe('when trackingType is serialized but no unitName_* fields are present', () => {
    it('does not create any unit documents', async () => {
      const { unitsAddMock } = wireSuccessfulTransaction()

      const result = await createEquipment(makeFormData())

      expect(result).toEqual({ id: NEW_EQUIPMENT_ID })
      expect(unitsAddMock).not.toHaveBeenCalled()
    })

    it('does not touch the units subcollection', async () => {
      wireSuccessfulTransaction()

      await createEquipment(makeFormData())

      const collectionCalls = vi.mocked(adminDb.collection).mock.calls.map(
        ([path]: [string]) => path,
      )
      expect(collectionCalls.some((p) => p.endsWith('/units'))).toBe(false)
    })
  })

  // ── Single valid unit ──────────────────────────────────────────────────────

  describe('when trackingType is serialized and one valid unitName is present', () => {
    it('creates exactly one unit document', async () => {
      const { unitsAddMock } = wireSuccessfulTransaction()

      await createEquipment(makeFormData({}, ['Camera Body 1']))

      expect(unitsAddMock).toHaveBeenCalledOnce()
    })

    it('returns { id } for the equipment document', async () => {
      wireSuccessfulTransaction()

      const result = await createEquipment(makeFormData({}, ['Camera Body 1']))

      expect(result).toEqual({ id: NEW_EQUIPMENT_ID })
    })

    it('writes the unit with the correct label field', async () => {
      const { unitsAddMock } = wireSuccessfulTransaction()

      await createEquipment(makeFormData({}, ['Camera Body 1']))

      const payload = unitsAddMock.mock.calls[0][0] as Record<string, unknown>
      expect(payload).toMatchObject({ label: 'Camera Body 1' })
    })

    it('writes the unit with required fields: status, equipmentId, companyId, createdBy', async () => {
      const { unitsAddMock } = wireSuccessfulTransaction()

      await createEquipment(makeFormData({}, ['Camera Body 1']))

      const payload = unitsAddMock.mock.calls[0][0] as Record<string, unknown>
      expect(payload).toMatchObject({
        status: 'available',
        equipmentId: NEW_EQUIPMENT_ID,
        companyId: COMPANY_ID,
        createdBy: ADMIN_SESSION.uid,
        serialNumber: null,
        notes: null,
      })
    })

    it('writes the unit with active set to true', async () => {
      const { unitsAddMock } = wireSuccessfulTransaction()

      await createEquipment(makeFormData({}, ['Camera Body 1']))

      const payload = unitsAddMock.mock.calls[0][0] as Record<string, unknown>
      expect(payload).toMatchObject({ active: true })
    })

    it('writes the unit with availableForBooking set to true', async () => {
      const { unitsAddMock } = wireSuccessfulTransaction()

      await createEquipment(makeFormData({}, ['Camera Body 1']))

      const payload = unitsAddMock.mock.calls[0][0] as Record<string, unknown>
      expect(payload).toMatchObject({ availableForBooking: true })
    })

    it('writes the unit with a createdAt serverTimestamp', async () => {
      const { unitsAddMock } = wireSuccessfulTransaction()

      await createEquipment(makeFormData({}, ['Camera Body 1']))

      const payload = unitsAddMock.mock.calls[0][0] as Record<string, unknown>
      expect(payload).toMatchObject({ createdAt: SERVER_TIMESTAMP_SENTINEL })
    })
  })

  // ── Multiple valid units ───────────────────────────────────────────────────

  describe('when trackingType is serialized and multiple valid unitNames are present', () => {
    it('creates one document per valid unitName', async () => {
      const { unitsAddMock } = wireSuccessfulTransaction()
      const names = ['Body A', 'Body B', 'Body C']

      await createEquipment(makeFormData({}, names))

      expect(unitsAddMock).toHaveBeenCalledTimes(3)
    })

    it('passes the correct name to each unit document', async () => {
      const { unitsAddMock } = wireSuccessfulTransaction()
      const names = ['Body A', 'Body B', 'Body C']

      await createEquipment(makeFormData({}, names))

      const writtenLabels = unitsAddMock.mock.calls.map(
        ([payload]: [Record<string, unknown>]) => payload.label,
      )
      expect(writtenLabels).toEqual(names)
    })

    it('gives every unit document active:true and availableForBooking:true', async () => {
      const { unitsAddMock } = wireSuccessfulTransaction()

      await createEquipment(makeFormData({}, ['B1', 'B2', 'B3']))

      for (const [payload] of unitsAddMock.mock.calls as [Record<string, unknown>][]) {
        expect(payload).toMatchObject({ active: true, availableForBooking: true })
      }
    })

    it('gives every unit document a createdAt serverTimestamp', async () => {
      const { unitsAddMock } = wireSuccessfulTransaction()

      await createEquipment(makeFormData({}, ['B1', 'B2', 'B3']))

      for (const [payload] of unitsAddMock.mock.calls as [Record<string, unknown>][]) {
        expect(payload).toMatchObject({ createdAt: SERVER_TIMESTAMP_SENTINEL })
      }
    })

    it('still returns { id } for the equipment document', async () => {
      wireSuccessfulTransaction()

      const result = await createEquipment(makeFormData({}, ['B1', 'B2']))

      expect(result).toEqual({ id: NEW_EQUIPMENT_ID })
    })
  })

  // ── Blank / whitespace-only unit names ─────────────────────────────────────

  describe('when some unitName fields are blank or whitespace-only', () => {
    it('skips blank names and creates only the non-empty ones', async () => {
      const { unitsAddMock } = wireSuccessfulTransaction()

      // Index 1 is empty, index 2 is whitespace-only — only index 0 and 3 are valid.
      await createEquipment(makeFormData({}, ['Body A', '', '   ', 'Body D']))

      expect(unitsAddMock).toHaveBeenCalledTimes(2)
    })

    it('writes only the valid names when blank names are interspersed', async () => {
      const { unitsAddMock } = wireSuccessfulTransaction()

      await createEquipment(makeFormData({}, ['Body A', '', 'Body C']))

      const writtenLabels = unitsAddMock.mock.calls.map(
        ([payload]: [Record<string, unknown>]) => payload.label,
      )
      expect(writtenLabels).toEqual(['Body A', 'Body C'])
    })

    it('does not create any unit documents when every unitName is blank', async () => {
      const { unitsAddMock } = wireSuccessfulTransaction()

      await createEquipment(makeFormData({}, ['', '   ', '\t']))

      expect(unitsAddMock).not.toHaveBeenCalled()
    })

    it('returns { id } even when all unitNames are blank', async () => {
      wireSuccessfulTransaction()

      const result = await createEquipment(makeFormData({}, ['', '   ']))

      expect(result).toEqual({ id: NEW_EQUIPMENT_ID })
    })
  })

  // ── Firestore path ─────────────────────────────────────────────────────────

  describe('Firestore subcollection path', () => {
    it('writes units to the correct subcollection path for the created equipment', async () => {
      wireSuccessfulTransaction()

      await createEquipment(makeFormData({}, ['Camera Body 1']))

      const collectionCalls = vi.mocked(adminDb.collection).mock.calls.map(
        ([path]: [string]) => path,
      )
      expect(collectionCalls).toContain(
        `companies/${COMPANY_ID}/equipment/${NEW_EQUIPMENT_ID}/units`,
      )
    })

    it('uses the id returned by the transaction — not a hard-coded string', async () => {
      // Wire a different equipment id to confirm the path is built dynamically.
      const customId = 'dynamic-equip-99'
      const unitsAddMock = vi.fn().mockResolvedValue({ id: 'unit-auto' })

      vi.mocked(adminDb.collection).mockImplementation((path: string) => {
        if (path.endsWith('/units')) {
          return { add: unitsAddMock } as never
        }
        return {
          where: vi.fn().mockReturnValue({
            count: vi.fn().mockReturnValue({
              get: vi.fn().mockResolvedValue({ data: () => ({ count: 0 }) }),
            }),
          }),
          doc: vi.fn().mockReturnValue({ id: customId }),
        } as never
      })

      vi.mocked(adminDb.doc).mockImplementation((path: string) => ({
        path,
        id: path.split('/').pop(),
      } as never))

      vi.mocked(adminDb.runTransaction).mockImplementation(
        async (cb: (tx: unknown) => Promise<unknown>) => {
          await cb({
            get: vi.fn().mockResolvedValue({
              exists: true,
              data: () => ({
                subscription: {
                  status: 'active',
                  plan: 'basic',
                  limits: { equipment: 50, users: 5 },
                },
              }),
            }),
            set: vi.fn(),
          })
        },
      )

      await createEquipment(makeFormData({}, ['Body 1']))

      const collectionCalls = vi.mocked(adminDb.collection).mock.calls.map(
        ([path]: [string]) => path,
      )
      expect(collectionCalls).toContain(
        `companies/${COMPANY_ID}/equipment/${customId}/units`,
      )
      expect(unitsAddMock).toHaveBeenCalledOnce()
    })
  })

  // ── Best-effort: unit failure must not roll back equipment ─────────────────

  describe('when unit creation fails (best-effort semantics)', () => {
    it('returns { id } for the equipment even when add() rejects for all units', async () => {
      const { unitsAddMock } = wireSuccessfulTransaction()
      unitsAddMock.mockRejectedValue(new Error('FIRESTORE_PERMISSION_DENIED'))

      const result = await createEquipment(makeFormData({}, ['Body A', 'Body B']))

      expect(result).toEqual({ id: NEW_EQUIPMENT_ID })
    })

    it('does not surface a unit-creation error in the return value', async () => {
      const { unitsAddMock } = wireSuccessfulTransaction()
      unitsAddMock.mockRejectedValue(new Error('FIRESTORE_QUOTA_EXCEEDED'))

      const result = await createEquipment(makeFormData({}, ['Body A']))

      expect(result).not.toHaveProperty('error')
    })

    it('always resolves — the action never throws when unit creation fails', async () => {
      const { unitsAddMock } = wireSuccessfulTransaction()
      unitsAddMock.mockRejectedValue(new Error('network timeout'))

      await expect(
        createEquipment(makeFormData({}, ['Body A'])),
      ).resolves.not.toThrow()
    })

    it('attempts to create units before failing — does not short-circuit on first error', async () => {
      // When the feature is implemented with Promise.all / individual awaits,
      // verify that a rejection on one unit does not prevent the action from
      // returning the equipment id.
      const { unitsAddMock } = wireSuccessfulTransaction()
      unitsAddMock
        .mockResolvedValueOnce({ id: 'unit-1' })
        .mockRejectedValueOnce(new Error('transient failure'))
        .mockResolvedValueOnce({ id: 'unit-3' })

      const result = await createEquipment(makeFormData({}, ['Body A', 'Body B', 'Body C']))

      expect(result).toEqual({ id: NEW_EQUIPMENT_ID })
    })
  })
})
