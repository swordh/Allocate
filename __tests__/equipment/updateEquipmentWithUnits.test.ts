import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {
    doc: vi.fn(),
    collection: vi.fn(),
    batch: vi.fn(),
    runTransaction: vi.fn(),
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

import { updateEquipmentWithUnits } from '@/actions/equipment'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { revalidatePath } from 'next/cache'
import { wireDb, makeTransaction, type DocMap, type TransactionStub } from '../helpers/firestore'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID = 'company-1'
const EQUIPMENT_ID = 'eq-1'

const EQUIP_PATH = `companies/${COMPANY_ID}/equipment/${EQUIPMENT_ID}`
const COUNTER_PATH = `companies/${COMPANY_ID}/_meta/equipmentCount`
const COMPANY_PATH = `companies/${COMPANY_ID}`
const unitPath = (id: string) => `${EQUIP_PATH}/units/${id}`

const ADMIN_SESSION = {
  uid: 'user-1',
  role: 'admin' as const,
  activeCompanyId: COMPANY_ID,
}

const NON_ADMIN_SESSION = { ...ADMIN_SESSION, role: 'crew' as const }

const EQUIPMENT_FIELDS = {
  name: 'ARRI Alexa Mini LF',
  category: 'Camera',
  description: null,
  requiresApproval: false,
  approverId: null,
  customFields: [],
}

const UNIT_UPDATE = {
  id: 'unit-1',
  label: 'Alexa #1',
  serialNumber: 'K1.0012345',
  status: 'ok' as const,
  notes: null,
  availableForBooking: true,
}

const NEW_UNIT = {
  label: 'Alexa #4',
  serialNumber: null,
  status: 'ok' as const,
  notes: null,
  availableForBooking: true,
}

let docs: DocMap
let tx: TransactionStub

/** Pulls the `count` increment out of a counter `tx.update` call (the FieldValue's operand). */
function counterDelta(): number | null {
  const call = tx.update.mock.calls.find(([ref]) => (ref as { path: string }).path === COUNTER_PATH)
  if (!call) return null
  return (call[1] as { count: { operand: number } }).count.operand
}

function baseDocs(overrides: { counter?: number | null; limit?: number; status?: string } = {}): DocMap {
  return {
    [COMPANY_PATH]: {
      subscription: {
        status: overrides.status ?? 'active',
        plan: 'starter',
        limits: { equipment: overrides.limit ?? 25, users: 10 },
      },
    },
    [COUNTER_PATH]: overrides.counter === null ? null : { count: overrides.counter ?? 5 },
    [EQUIP_PATH]: { name: 'ARRI Alexa Mini LF', category: 'Camera', trackingType: 'units', active: true },
    [unitPath('unit-1')]: { label: 'Alexa #1', active: true },
    [unitPath('unit-2')]: { label: 'Alexa #2', active: true },
    [unitPath('unit-99')]: { label: 'Gone', active: true },
  }
}

function wire(d: DocMap) {
  docs = d
  wireDb(adminDb as unknown as Record<string, unknown>, { docs })
  tx = makeTransaction(docs)
  vi.mocked(adminDb.runTransaction).mockImplementation(((cb: (t: unknown) => unknown) => cb(tx)) as never)
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getVerifiedSession).mockResolvedValue(ADMIN_SESSION as never)
  wire(baseDocs())
})

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('returns Unauthorized for non-admin', async () => {
    vi.mocked(getVerifiedSession).mockResolvedValue(NON_ADMIN_SESSION as never)

    const result = await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [], [])

    expect(result).toEqual({ error: 'Unauthorized' })
    expect(vi.mocked(adminDb.runTransaction)).not.toHaveBeenCalled()
  })
})

// ── Validation ────────────────────────────────────────────────────────────────

describe('validation', () => {
  it('rejects blank equipmentId', async () => {
    const result = await updateEquipmentWithUnits('   ', EQUIPMENT_FIELDS, [], [], [])
    expect(result).toEqual({ error: expect.stringContaining('equipmentId') })
  })

  it('rejects equipmentId containing a slash', async () => {
    const result = await updateEquipmentWithUnits('eq/bad', EQUIPMENT_FIELDS, [], [], [])
    expect(result).toEqual({ error: expect.stringContaining('equipmentId') })
  })

  it('rejects blank name', async () => {
    const result = await updateEquipmentWithUnits(
      EQUIPMENT_ID,
      { ...EQUIPMENT_FIELDS, name: '   ' },
      [], [], []
    )
    expect(result).toEqual({ error: expect.stringContaining('name') })
  })

  it('rejects name over 100 chars', async () => {
    const result = await updateEquipmentWithUnits(
      EQUIPMENT_ID,
      { ...EQUIPMENT_FIELDS, name: 'x'.repeat(101) },
      [], [], []
    )
    expect(result).toEqual({ error: expect.stringContaining('100') })
  })

  it('rejects blank category', async () => {
    const result = await updateEquipmentWithUnits(
      EQUIPMENT_ID,
      { ...EQUIPMENT_FIELDS, category: '' },
      [], [], []
    )
    expect(result).toEqual({ error: expect.stringContaining('category') })
  })

  it('rejects invalid unit status in unitUpdates', async () => {
    const result = await updateEquipmentWithUnits(
      EQUIPMENT_ID,
      EQUIPMENT_FIELDS,
      [{ ...UNIT_UPDATE, status: 'broken' as never }],
      [], []
    )
    expect(result).toEqual({ error: expect.stringContaining('status') })
  })

  it('rejects invalid unit status in unitCreates', async () => {
    const result = await updateEquipmentWithUnits(
      EQUIPMENT_ID,
      EQUIPMENT_FIELDS,
      [],
      [{ label: 'New', serialNumber: null, status: 'broken' as never, notes: null, availableForBooking: true }],
      []
    )
    expect(result).toEqual({ error: expect.stringContaining('status') })
  })

  it('rejects unit id containing a slash (path injection)', async () => {
    const result = await updateEquipmentWithUnits(
      EQUIPMENT_ID,
      EQUIPMENT_FIELDS,
      [{ ...UNIT_UPDATE, id: '../../../malicious' }],
      [], []
    )
    expect(result).toEqual({ error: 'Invalid unit id' })
  })

  it('rejects deleted unit id containing a slash', async () => {
    const result = await updateEquipmentWithUnits(
      EQUIPMENT_ID,
      EQUIPMENT_FIELDS,
      [], [],
      ['../../../malicious']
    )
    expect(result).toEqual({ error: 'Invalid unit id' })
  })

  it('rejects unit with empty label', async () => {
    const result = await updateEquipmentWithUnits(
      EQUIPMENT_ID,
      EQUIPMENT_FIELDS,
      [{ ...UNIT_UPDATE, label: '   ' }],
      [], []
    )
    expect(result).toEqual({ error: expect.stringContaining('label') })
  })

  it('rejects crew role (non-admin)', async () => {
    vi.mocked(getVerifiedSession).mockResolvedValue({ ...ADMIN_SESSION, role: 'crew' } as never)
    const result = await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [], [])
    expect(result).toEqual({ error: 'Unauthorized' })
  })
})

// ── Equipment not found ───────────────────────────────────────────────────────

describe('equipment not found', () => {
  it('returns error when equipment doc does not exist', async () => {
    wire({ ...baseDocs(), [EQUIP_PATH]: null })

    const result = await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [], [])
    expect(result).toEqual({ error: expect.stringContaining('not found') })
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('returns error when equipment is inactive', async () => {
    wire({ ...baseDocs(), [EQUIP_PATH]: { active: false } })

    const result = await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [], [])
    expect(result).toEqual({ error: expect.stringContaining('not found') })
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('refuses unit creates/deletes on a quantity-tracked item', async () => {
    wire({ ...baseDocs(), [EQUIP_PATH]: { trackingType: 'quantity', totalQuantity: 4, active: true } })

    const result = await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [NEW_UNIT], [])
    expect(result).toEqual({ error: expect.stringContaining('unit-tracked') })
    expect(tx.set).not.toHaveBeenCalled()
  })
})

// ── Equipment update ──────────────────────────────────────────────────────────

describe('equipment update', () => {
  it('updates the equipment doc inside the transaction with the correct fields', async () => {
    await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [], [])

    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: EQUIP_PATH }),
      expect.objectContaining({
        name: 'ARRI Alexa Mini LF',
        category: 'Camera',
        requiresApproval: false,
      }),
    )
  })

  it('revalidates /equipment and returns no error', async () => {
    const result = await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [], [])

    expect(result).toEqual({})
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith('/equipment')
  })

  it('does not touch the counter when no unit is created or removed', async () => {
    await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [UNIT_UPDATE], [], [])

    expect(counterDelta()).toBeNull()
    expect(tx.set).not.toHaveBeenCalled()
  })
})

// ── Unit updates ──────────────────────────────────────────────────────────────

describe('unit updates', () => {
  it('updates each unit in unitUpdates at the right path', async () => {
    await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [UNIT_UPDATE], [], [])

    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: unitPath('unit-1') }),
      expect.objectContaining({
        label: 'Alexa #1',
        serialNumber: 'K1.0012345',
        status: 'ok',
        availableForBooking: true,
      }),
    )
  })

  it('handles multiple unit updates in one transaction', async () => {
    const units = [
      { ...UNIT_UPDATE, id: 'unit-1', label: 'Alexa #1' },
      { ...UNIT_UPDATE, id: 'unit-2', label: 'Alexa #2', status: 'ok' as const },
    ]

    await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, units, [], [])

    // equipment update + 2 unit updates
    expect(tx.update).toHaveBeenCalledTimes(3)
  })
})

// ── Unit creates ──────────────────────────────────────────────────────────────

describe('unit creates', () => {
  it('sets each new unit with the correct fields', async () => {
    await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [NEW_UNIT], [])

    expect(tx.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        label: 'Alexa #4',
        status: 'ok',
        active: true,
        equipmentId: EQUIPMENT_ID,
        companyId: COMPANY_ID,
      }),
    )
  })

  it('increments the counter by the number of created units', async () => {
    await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [NEW_UNIT, NEW_UNIT, NEW_UNIT], [])

    expect(counterDelta()).toBe(3)
  })

  it('rejects creates that would take the counter over the plan limit and writes nothing', async () => {
    wire(baseDocs({ counter: 24, limit: 25 }))

    const result = await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [NEW_UNIT, NEW_UNIT], [])

    expect(result).toEqual({ error: expect.stringContaining('Equipment limit reached') })
    expect(tx.set).not.toHaveBeenCalled()
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('allows creates that land exactly on the limit', async () => {
    wire(baseDocs({ counter: 23, limit: 25 }))

    const result = await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [NEW_UNIT, NEW_UNIT], [])

    expect(result).toEqual({})
    expect(counterDelta()).toBe(2)
  })

  it('rejects creates when the subscription is not active', async () => {
    wire(baseDocs({ status: 'canceled' }))

    const result = await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [NEW_UNIT], [])

    expect(result).toEqual({ error: expect.stringContaining('Subscription is not active') })
    expect(tx.set).not.toHaveBeenCalled()
  })
})

// ── Unit deletes ──────────────────────────────────────────────────────────────

describe('unit deletes', () => {
  it('deactivates each deleted unit and decrements the counter', async () => {
    await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [], ['unit-99'])

    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: unitPath('unit-99') }),
      expect.objectContaining({ active: false }),
    )
    expect(counterDelta()).toBe(-1)
  })

  it('does not decrement for a unit that was already inactive', async () => {
    wire({ ...baseDocs(), [unitPath('unit-99')]: { label: 'Gone', active: false } })

    await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [], ['unit-99'])

    expect(counterDelta()).toBeNull()
    expect(tx.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: unitPath('unit-99') }),
      expect.anything(),
    )
  })

  it('counts a unit listed twice only once', async () => {
    await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [], ['unit-99', 'unit-99'])

    expect(counterDelta()).toBe(-1)
  })

  it('nets creates against deletes, and lets a swap through on a full plan', async () => {
    wire(baseDocs({ counter: 25, limit: 25 }))

    const result = await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [NEW_UNIT], ['unit-99'])

    // +1 -1 = 0: no limit check needed, no counter write
    expect(result).toEqual({})
    expect(counterDelta()).toBeNull()
  })
})

// ── Error handling ────────────────────────────────────────────────────────────

describe('error handling', () => {
  it('returns generic error when the transaction throws (does not leak internals)', async () => {
    vi.mocked(adminDb.runTransaction).mockRejectedValue(new Error('Firestore quota exceeded (internal)'))

    const result = await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [], [])

    // Must NOT leak the internal Firestore error to the client
    expect(result?.error).toBeTruthy()
    expect(result?.error).not.toContain('quota')
    expect(result?.error).not.toContain('Firestore')
  })

  it('handles non-Error rejections gracefully', async () => {
    vi.mocked(adminDb.runTransaction).mockRejectedValue('network error')

    const result = await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [], [])

    expect(result?.error).toBeTruthy()
  })
})
