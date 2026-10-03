/**
 * Issue #284 — the equipment counter counts ITEMS, not type documents.
 *
 * Per active type: active unit documents (`units` / legacy types without a
 * trackingType) or `totalQuantity` (`quantity` types). Soft-deleted types and
 * units count 0. These tests pin how each write path moves
 * `companies/{id}/_meta/equipmentCount`:
 *
 *   - updateEquipment     quantity changes move it by (new − old), guarded on increase
 *   - createUnit          +1, guarded by plan limit and subscription status
 *   - deactivateUnit      −1 once, only while the parent type is active
 *
 * createEquipment / createEquipmentWithUnits / deactivateEquipment /
 * updateEquipmentWithUnits are covered next to their own suites.
 *
 * Firebase Admin and getVerifiedSession are mocked; no network calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {
    doc: vi.fn(),
    collection: vi.fn(),
    runTransaction: vi.fn(),
    batch: vi.fn(),
  },
  adminAuth: {},
}))

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { updateEquipment, createUnit, deactivateUnit } from '@/actions/equipment'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { wireDb, makeTransaction, type DocMap, type TransactionStub } from '../helpers/firestore'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID = 'company-abc'
const EQUIPMENT_ID = 'equip-1'
const UNIT_ID = 'unit-1'

const COMPANY_PATH = `companies/${COMPANY_ID}`
const COUNTER_PATH = `companies/${COMPANY_ID}/_meta/equipmentCount`
const EQUIP_PATH = `${COMPANY_PATH}/equipment/${EQUIPMENT_ID}`
const UNIT_PATH = `${EQUIP_PATH}/units/${UNIT_ID}`

const ADMIN_SESSION = {
  uid: 'user-admin',
  email: 'admin@example.com',
  activeCompanyId: COMPANY_ID,
  role: 'admin' as const,
}

interface Setup {
  count?: number | null // null = counter document missing
  limit?: number
  status?: string
  equipment?: Record<string, unknown> | null
  unit?: Record<string, unknown> | null
}

let docs: DocMap
let tx: TransactionStub

function wire(setup: Setup = {}) {
  docs = {
    [COMPANY_PATH]: {
      subscription: {
        status: setup.status ?? 'active',
        plan: 'starter',
        limits: { equipment: setup.limit ?? 25, users: 10 },
      },
    },
    [COUNTER_PATH]: setup.count === null ? null : { count: setup.count ?? 10 },
    [EQUIP_PATH]:
      setup.equipment === undefined
        ? { name: 'Cam', trackingType: 'units', active: true }
        : setup.equipment,
    [UNIT_PATH]: setup.unit === undefined ? { label: 'A', active: true } : setup.unit,
  }
  const wired = wireDb(adminDb as unknown as Record<string, unknown>, { docs })
  tx = makeTransaction(docs)
  vi.mocked(adminDb.runTransaction).mockImplementation(((cb: (t: unknown) => unknown) => cb(tx)) as never)
  return wired
}

/** The counter increment a transaction wrote, or null when it never touched the counter. */
function counterDelta(): number | null {
  const call = tx.update.mock.calls.find(([ref]) => (ref as { path: string }).path === COUNTER_PATH)
  return call ? (call[1] as { count: { operand: number } }).count.operand : null
}

function mirrorWritten(): boolean {
  return tx.set.mock.calls.some(([ref]) => (ref as { path: string }).path === COMPANY_PATH)
}

function qtyForm(totalQuantity: number): FormData {
  const fd = new FormData()
  fd.set('totalQuantity', String(totalQuantity))
  return fd
}

function unitForm(label = 'Alexa #1'): FormData {
  const fd = new FormData()
  fd.set('label', label)
  return fd
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getVerifiedSession).mockResolvedValue(ADMIN_SESSION)
})

// ═════════════════════════════════════════════════════════════════════════════
// updateEquipment — totalQuantity
// ═════════════════════════════════════════════════════════════════════════════

describe('updateEquipment — quantity changes move the counter', () => {
  const quantityItem = { name: 'Batteries', trackingType: 'quantity', totalQuantity: 10, active: true }

  it('increases the counter by the difference when quantity grows within the limit', async () => {
    wire({ count: 15, limit: 25, equipment: quantityItem })

    const result = await updateEquipment(EQUIPMENT_ID, qtyForm(14))

    expect(result).toEqual({})
    expect(counterDelta()).toBe(4)
    expect(mirrorWritten()).toBe(true)
    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: EQUIP_PATH }),
      expect.objectContaining({ totalQuantity: 14 }),
    )
  })

  it('allows growth that lands exactly on the limit', async () => {
    wire({ count: 15, limit: 25, equipment: quantityItem })

    const result = await updateEquipment(EQUIPMENT_ID, qtyForm(20))

    expect(result).toEqual({})
    expect(counterDelta()).toBe(10)
  })

  it('rejects growth over the limit and writes nothing', async () => {
    wire({ count: 15, limit: 25, equipment: quantityItem })

    const result = await updateEquipment(EQUIPMENT_ID, qtyForm(21))

    expect(result).toEqual({ error: expect.stringContaining('Equipment limit reached') })
    expect(tx.update).not.toHaveBeenCalled()
    expect(tx.set).not.toHaveBeenCalled()
  })

  it('rejects growth when the subscription is not active', async () => {
    wire({ count: 5, status: 'past_due', equipment: quantityItem })

    const result = await updateEquipment(EQUIPMENT_ID, qtyForm(11))

    expect(result).toEqual({ error: expect.stringContaining('Subscription is not active') })
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('decrements the counter when quantity shrinks, even when the plan is over its limit', async () => {
    wire({ count: 30, limit: 25, equipment: quantityItem })

    const result = await updateEquipment(EQUIPMENT_ID, qtyForm(4))

    expect(result).toEqual({})
    expect(counterDelta()).toBe(-6)
  })

  it('leaves the counter alone when the quantity is unchanged', async () => {
    wire({ count: 15, equipment: quantityItem })

    await updateEquipment(EQUIPMENT_ID, qtyForm(10))

    expect(counterDelta()).toBeNull()
    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: EQUIP_PATH }),
      expect.objectContaining({ totalQuantity: 10 }),
    )
  })

  it('does not count quantity changes on a deactivated type, and never limit-checks them', async () => {
    wire({ count: 25, limit: 25, equipment: { ...quantityItem, active: false } })

    const result = await updateEquipment(EQUIPMENT_ID, qtyForm(50))

    expect(result).toEqual({})
    expect(counterDelta()).toBeNull()
  })

  it('reads the old quantity inside the transaction, not from the pre-read', async () => {
    // The pre-read (outside the transaction) sees 10; by the time the
    // transaction reads, a concurrent update has made it 20.
    wire({ count: 20, limit: 25, equipment: quantityItem })
    docs[EQUIP_PATH] = { ...quantityItem, totalQuantity: 20 }
    const preRead = { exists: true, data: () => quantityItem }
    vi.mocked(adminDb.doc).mockImplementationOnce(
      (path: string) => ({ path, id: EQUIPMENT_ID, get: async () => preRead }) as never,
    )

    await updateEquipment(EQUIPMENT_ID, qtyForm(22))

    expect(counterDelta()).toBe(2) // 22 − 20, not 22 − 10
  })

  it('updates non-quantity fields with a plain write, no transaction', async () => {
    const { doc } = wire({ equipment: quantityItem })
    const update = vi.fn().mockResolvedValue(undefined)
    doc.mockImplementation((path: string) => ({
      path,
      id: path.split('/').pop(),
      get: async () => ({ exists: true, data: () => quantityItem }),
      update,
    }))
    const fd = new FormData()
    fd.set('name', 'AA batteries')

    const result = await updateEquipment(EQUIPMENT_ID, fd)

    expect(result).toEqual({})
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ name: 'AA batteries' }))
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// createUnit
// ═════════════════════════════════════════════════════════════════════════════

describe('createUnit — plan limit and counter', () => {
  it('writes the unit and increments the counter and mirror by one', async () => {
    wire({ count: 10, limit: 25 })

    const result = await createUnit(EQUIPMENT_ID, unitForm())

    expect(result).toHaveProperty('id')
    expect(counterDelta()).toBe(1)
    expect(mirrorWritten()).toBe(true)
    expect(tx.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ label: 'Alexa #1', active: true, equipmentId: EQUIPMENT_ID, companyId: COMPANY_ID }),
    )
  })

  it('is rejected at the plan limit and writes neither unit, counter nor mirror', async () => {
    wire({ count: 25, limit: 25 })

    const result = await createUnit(EQUIPMENT_ID, unitForm())

    expect(result).toEqual({ error: expect.stringContaining('Equipment limit reached') })
    expect(tx.set).not.toHaveBeenCalled()
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('is allowed on the last free slot', async () => {
    wire({ count: 24, limit: 25 })

    const result = await createUnit(EQUIPMENT_ID, unitForm())

    expect(result).toHaveProperty('id')
    expect(counterDelta()).toBe(1)
  })

  it('is rejected when the subscription is not active (it used to skip this check)', async () => {
    wire({ count: 0, status: 'canceled' })

    const result = await createUnit(EQUIPMENT_ID, unitForm())

    expect(result).toEqual({ error: expect.stringContaining('Subscription is not active') })
    expect(tx.set).not.toHaveBeenCalled()
  })

  it('is rejected when the counter document is missing', async () => {
    wire({ count: null })

    const result = await createUnit(EQUIPMENT_ID, unitForm())

    expect(result).toEqual({ error: expect.stringContaining('backfill') })
    expect(tx.set).not.toHaveBeenCalled()
  })

  it('is rejected under a deactivated type', async () => {
    wire({ equipment: { trackingType: 'units', active: false } })

    const result = await createUnit(EQUIPMENT_ID, unitForm())

    expect(result).toEqual({ error: 'Cannot add units to deactivated equipment.' })
    expect(tx.set).not.toHaveBeenCalled()
  })

  it('is rejected under a quantity-tracked type', async () => {
    wire({ equipment: { trackingType: 'quantity', totalQuantity: 3, active: true } })

    const result = await createUnit(EQUIPMENT_ID, unitForm())

    expect(result).toEqual({ error: 'Units can only be added to unit-tracked equipment.' })
    expect(tx.set).not.toHaveBeenCalled()
  })

  it('is rejected when the type does not exist', async () => {
    wire({ equipment: null })

    const result = await createUnit(EQUIPMENT_ID, unitForm())

    expect(result).toEqual({ error: 'Equipment not found.' })
  })

  it('accepts a legacy type with no trackingType', async () => {
    wire({ count: 3, equipment: { name: 'Old cam', active: true } })

    const result = await createUnit(EQUIPMENT_ID, unitForm())

    expect(result).toHaveProperty('id')
    expect(counterDelta()).toBe(1)
  })

  it('rejects a blank label before touching Firestore', async () => {
    wire()

    const result = await createUnit(EQUIPMENT_ID, unitForm('   '))

    expect(result).toEqual({ error: 'Label is required.' })
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
  })

  it('does not leak internal errors from the transaction', async () => {
    wire()
    vi.mocked(adminDb.runTransaction).mockRejectedValue(new Error('UNAVAILABLE: upstream connect error'))

    const result = await createUnit(EQUIPMENT_ID, unitForm())

    expect(result).toEqual({ error: expect.not.stringContaining('UNAVAILABLE') })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// deactivateUnit
// ═════════════════════════════════════════════════════════════════════════════

describe('deactivateUnit — counter', () => {
  it('deactivates an active unit under an active type and decrements by one', async () => {
    wire({ count: 10 })

    const result = await deactivateUnit(EQUIPMENT_ID, UNIT_ID)

    expect(result).toBeUndefined()
    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: UNIT_PATH }),
      expect.objectContaining({ active: false }),
    )
    expect(counterDelta()).toBe(-1)
    expect(mirrorWritten()).toBe(true)
  })

  it('is idempotent: a second call on the same unit does not decrement again', async () => {
    wire({ count: 10 })
    await deactivateUnit(EQUIPMENT_ID, UNIT_ID)
    expect(counterDelta()).toBe(-1)

    // the first call committed: the unit now reads as inactive
    docs[UNIT_PATH] = { label: 'A', active: false }
    tx.update.mockClear()
    tx.set.mockClear()

    const second = await deactivateUnit(EQUIPMENT_ID, UNIT_ID)

    expect(second).toBeUndefined()
    expect(tx.update).not.toHaveBeenCalled()
    expect(tx.set).not.toHaveBeenCalled()
  })

  it('deactivates the unit but leaves the counter alone when the parent type is already inactive', async () => {
    wire({ count: 10, equipment: { trackingType: 'units', active: false } })

    await deactivateUnit(EQUIPMENT_ID, UNIT_ID)

    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: UNIT_PATH }),
      expect.objectContaining({ active: false }),
    )
    expect(counterDelta()).toBeNull()
    expect(mirrorWritten()).toBe(false)
  })

  it('still works when the plan is over its limit (count 40, limit 25): removing is never blocked', async () => {
    wire({ count: 40, limit: 25 })

    const result = await deactivateUnit(EQUIPMENT_ID, UNIT_ID)

    expect(result).toBeUndefined()
    expect(counterDelta()).toBe(-1)
  })

  it('returns an error for a unit that does not exist', async () => {
    wire({ unit: null })

    const result = await deactivateUnit(EQUIPMENT_ID, UNIT_ID)

    expect(result).toEqual({ error: 'Unit not found.' })
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
  })

  it('fails with the backfill message when the counter is missing and the decrement is needed', async () => {
    wire({ count: null })

    const result = await deactivateUnit(EQUIPMENT_ID, UNIT_ID)

    expect(result).toEqual({ error: expect.stringContaining('backfill') })
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('still asks for force when a future booking references the unit', async () => {
    const { collection } = wire({ count: 10 })
    // deactivateUnit walks companies/{id}/bookings via chained .collection().doc().collection()
    collection.mockImplementation(() => ({
      doc: () => ({
        collection: () => ({
          where: () => ({
            where: () => ({
              get: async () => ({ docs: [{ data: () => ({ status: 'confirmed', endDate: '2099-01-01' }) }] }),
            }),
          }),
        }),
      }),
    }))

    const result = await deactivateUnit(EQUIPMENT_ID, UNIT_ID)

    expect(result).toEqual({ requiresForce: true, futureBookingCount: 1 })
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
  })
})
