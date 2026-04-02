import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('@/lib/firebase-admin', () => {
  const mockBatch = {
    update: vi.fn(),
    set: vi.fn(),
    commit: vi.fn().mockResolvedValue(undefined),
  }
  const mockEquipRef = {
    get: vi.fn().mockResolvedValue({
      exists: true,
      data: () => ({
        name: 'ARRI Alexa Mini LF',
        category: 'Camera',
        trackingType: 'serialized',
        active: true,
      }),
    }),
    update: vi.fn(),
  }
  const mockUnitRef = { update: vi.fn(), set: vi.fn() }
  const mockNewUnitRef = { id: 'new-unit-1' }
  const mockCollection = {
    doc: vi.fn().mockReturnValue(mockNewUnitRef),
  }
  const mockDb = {
    doc: vi.fn().mockReturnValue(mockEquipRef),
    collection: vi.fn().mockReturnValue(mockCollection),
    batch: vi.fn().mockReturnValue(mockBatch),
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

import { updateEquipmentWithUnits } from '@/actions/equipment'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { revalidatePath } from 'next/cache'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID = 'company-1'
const EQUIPMENT_ID = 'eq-1'

const ADMIN_SESSION = {
  uid: 'user-1',
  role: 'admin' as const,
  activeCompanyId: COMPANY_ID,
}

const NON_ADMIN_SESSION = { ...ADMIN_SESSION, role: 'viewer' as const }

const EQUIPMENT_FIELDS = {
  name: 'ARRI Alexa Mini LF',
  category: 'Camera',
  description: null,
  requiresApproval: false,
  approverId: null,
  customFields: [] as const,
}

const UNIT_UPDATE = {
  id: 'unit-1',
  label: 'Alexa #1',
  serialNumber: 'K1.0012345',
  status: 'available' as const,
  notes: null,
  availableForBooking: true,
}

function getBatch() {
  return vi.mocked(adminDb.batch).mock.results[0]?.value as {
    update: ReturnType<typeof vi.fn>
    set: ReturnType<typeof vi.fn>
    commit: ReturnType<typeof vi.fn>
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getVerifiedSession).mockResolvedValue(ADMIN_SESSION as any)

  const mockBatch = {
    update: vi.fn(),
    set: vi.fn(),
    commit: vi.fn().mockResolvedValue(undefined),
  }
  vi.mocked(adminDb.batch).mockReturnValue(mockBatch as any)

  vi.mocked(adminDb.doc).mockReturnValue({
    get: vi.fn().mockResolvedValue({
      exists: true,
      data: () => ({
        name: 'ARRI Alexa Mini LF',
        category: 'Camera',
        trackingType: 'serialized',
        active: true,
      }),
    }),
    update: vi.fn(),
  } as any)

  vi.mocked(adminDb.collection).mockReturnValue({
    doc: vi.fn().mockReturnValue({ id: 'new-unit-1' }),
  } as any)
})

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('returns Unauthorized for non-admin', async () => {
    vi.mocked(getVerifiedSession).mockResolvedValue(NON_ADMIN_SESSION as any)

    const result = await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [], [])

    expect(result).toEqual({ error: 'Unauthorized' })
    expect(vi.mocked(adminDb.batch)).not.toHaveBeenCalled()
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
      [{ ...UNIT_UPDATE, status: 'broken' as any }],
      [], []
    )
    expect(result).toEqual({ error: expect.stringContaining('status') })
  })

  it('rejects invalid unit status in unitCreates', async () => {
    const result = await updateEquipmentWithUnits(
      EQUIPMENT_ID,
      EQUIPMENT_FIELDS,
      [],
      [{ label: 'New', serialNumber: null, status: 'broken' as any, notes: null }],
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
    vi.mocked(getVerifiedSession).mockResolvedValue({ ...ADMIN_SESSION, role: 'crew' } as any)
    const result = await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [], [])
    expect(result).toEqual({ error: 'Unauthorized' })
  })
})

// ── Equipment not found ───────────────────────────────────────────────────────

describe('equipment not found', () => {
  it('returns error when equipment doc does not exist', async () => {
    vi.mocked(adminDb.doc).mockReturnValue({
      get: vi.fn().mockResolvedValue({ exists: false, data: () => undefined }),
    } as any)

    const result = await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [], [])
    expect(result).toEqual({ error: expect.stringContaining('not found') })
  })

  it('returns error when equipment is inactive', async () => {
    vi.mocked(adminDb.doc).mockReturnValue({
      get: vi.fn().mockResolvedValue({
        exists: true,
        data: () => ({ active: false }),
      }),
    } as any)

    const result = await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [], [])
    expect(result).toEqual({ error: expect.stringContaining('not found') })
  })
})

// ── Equipment update ──────────────────────────────────────────────────────────

describe('equipment update', () => {
  it('calls batch.update on the equipment doc with correct fields', async () => {
    await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [], [])

    expect(vi.mocked(adminDb.doc)).toHaveBeenCalledWith(
      `companies/${COMPANY_ID}/equipment/${EQUIPMENT_ID}`
    )
    const batch = getBatch()
    expect(batch.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: 'ARRI Alexa Mini LF',
        category: 'Camera',
        requiresApproval: false,
      })
    )
  })

  it('commits the batch and revalidates /equipment', async () => {
    await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [], [])

    expect(getBatch().commit).toHaveBeenCalledOnce()
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith('/equipment')
  })
})

// ── Unit updates ──────────────────────────────────────────────────────────────

describe('unit updates', () => {
  it('calls batch.update for each unit in unitUpdates with correct path', async () => {
    await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [UNIT_UPDATE], [], [])

    expect(vi.mocked(adminDb.doc)).toHaveBeenCalledWith(
      `companies/${COMPANY_ID}/equipment/${EQUIPMENT_ID}/units/unit-1`
    )
    const batch = getBatch()
    expect(batch.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        label: 'Alexa #1',
        serialNumber: 'K1.0012345',
        status: 'available',
        availableForBooking: true,
      })
    )
  })

  it('handles multiple unit updates in one batch', async () => {
    const units = [
      { ...UNIT_UPDATE, id: 'unit-1', label: 'Alexa #1' },
      { ...UNIT_UPDATE, id: 'unit-2', label: 'Alexa #2', status: 'checked_out' as const },
    ]

    await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, units, [], [])

    // equipment update + 2 unit updates = 3 batch.update calls
    expect(getBatch().update).toHaveBeenCalledTimes(3)
  })
})

// ── Unit creates ──────────────────────────────────────────────────────────────

describe('unit creates', () => {
  it('calls batch.set for each new unit with correct fields', async () => {
    const newUnit = {
      label: 'Alexa #4',
      serialNumber: null,
      status: 'available' as const,
      notes: null,
    }

    await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [newUnit], [])

    expect(getBatch().set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        label: 'Alexa #4',
        status: 'available',
        active: true,
        equipmentId: EQUIPMENT_ID,
        companyId: COMPANY_ID,
      })
    )
  })
})

// ── Unit deletes ──────────────────────────────────────────────────────────────

describe('unit deletes', () => {
  it('calls batch.update with active:false for each deleted unit id', async () => {
    await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [], ['unit-99'])

    expect(vi.mocked(adminDb.doc)).toHaveBeenCalledWith(
      `companies/${COMPANY_ID}/equipment/${EQUIPMENT_ID}/units/unit-99`
    )
    expect(getBatch().update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ active: false })
    )
  })
})

// ── Error handling ────────────────────────────────────────────────────────────

describe('error handling', () => {
  it('returns generic error when batch.commit throws (does not leak internals)', async () => {
    const batch = {
      update: vi.fn(),
      set: vi.fn(),
      commit: vi.fn().mockRejectedValue(new Error('Firestore quota exceeded (internal)')),
    }
    vi.mocked(adminDb.batch).mockReturnValue(batch as any)

    const result = await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [], [])

    // Must NOT leak the internal Firestore error to the client
    expect(result?.error).toBeTruthy()
    expect(result?.error).not.toContain('quota')
    expect(result?.error).not.toContain('Firestore')
  })

  it('handles non-Error rejections gracefully', async () => {
    const batch = {
      update: vi.fn(),
      set: vi.fn(),
      commit: vi.fn().mockRejectedValue('network error'),
    }
    vi.mocked(adminDb.batch).mockReturnValue(batch as any)

    const result = await updateEquipmentWithUnits(EQUIPMENT_ID, EQUIPMENT_FIELDS, [], [], [])

    expect(result?.error).toBeTruthy()
  })
})
