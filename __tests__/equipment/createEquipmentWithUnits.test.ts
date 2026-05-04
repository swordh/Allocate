/**
 * Tests for createEquipmentWithUnits server action.
 *
 * Covers:
 *   - Auth guard: non-admin users are blocked before any Firestore call
 *   - Input validation: name, category, totalQuantity, unit label, unit status
 *   - Plan limit enforcement: at-limit and inactive subscription
 *   - Happy path without units: transaction runs, returns { id }
 *   - Happy path with units: transaction + batch.set per unit, returns { id }
 *   - Error handling: batch.commit throws, internal details must not leak
 *
 * Firebase Admin and getVerifiedSession are fully mocked; no network calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('@/lib/firebase-admin', () => {
  const mockDb = {
    doc: vi.fn(),
    collection: vi.fn(),
    runTransaction: vi.fn(),
    batch: vi.fn(),
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

import { createEquipmentWithUnits } from '@/actions/equipment'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import type { CustomField } from '@/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID = 'company-abc'

const ADMIN_SESSION = {
  uid: 'user-admin',
  email: 'admin@example.com',
  activeCompanyId: COMPANY_ID,
  role: 'admin' as const,
}

const NON_ADMIN_SESSION = {
  uid: 'user-crew',
  email: 'crew@example.com',
  activeCompanyId: COMPANY_ID,
  role: 'crew' as const,
}

const VALID_FIELDS = {
  name: 'ARRI Alexa Mini LF',
  description: null,
  category: 'Camera',
  trackingType: 'units' as const,
  totalQuantity: 1,
  requiresApproval: false,
  approverId: null,
  customFields: [] as CustomField[],
}

const VALID_UNIT = {
  label: 'Alexa #1',
  serialNumber: 'K1.0012345',
  status: 'ok' as const,
  notes: null,
  availableForBooking: true,
}

// ── Helper: wire the Firestore transaction and plan-limit snapshot ──────────

/**
 * Sets up adminDb.runTransaction to call the callback immediately with a mock
 * transaction that routes tx.get() by document path — returning the company doc
 * for the company path and the counter doc for the _meta/equipmentCount path.
 * Returns the transaction mock and the generated equipment id.
 */
function wireCreateEquipmentTransaction(
  subscriptionStatus: string,
  plan: string,
  equipmentLimit: number,
  currentEquipmentCount: number,
) {
  const newDocId = 'new-equip-id'
  const counterPath = `companies/${COMPANY_ID}/_meta/equipmentCount`

  const tx = {
    get: vi.fn().mockImplementation(async (ref: { path: string }) => {
      if (ref.path === `companies/${COMPANY_ID}`) {
        return {
          exists: true,
          data: () => ({
            subscription: {
              status: subscriptionStatus,
              plan,
              limits: { equipment: equipmentLimit, users: 5 },
            },
          }),
        }
      }
      if (ref.path === counterPath) {
        return {
          exists: true,
          data: () => ({ count: currentEquipmentCount }),
        }
      }
      return { exists: false, data: () => ({}) }
    }),
    set: vi.fn(),
    update: vi.fn(),
  }

  vi.mocked(adminDb.runTransaction).mockImplementation(
    (async (cb: (tx: unknown) => Promise<unknown>) => {
      await cb(tx)
    }) as never,
  )

  vi.mocked(adminDb.doc).mockImplementation((path: string) => ({
    path,
    id: path.split('/').pop(),
  } as never))

  // adminDb.collection is used for:
  //   1. Getting the new equipment doc ref (.doc().id) inside the transaction
  //   2. Getting unit doc refs for the post-transaction batch write
  vi.mocked(adminDb.collection).mockImplementation((path: string) => ({
    doc: vi.fn().mockReturnValue({
      id: newDocId,
      path: `${path}/${newDocId}`,
    }),
  } as never))

  return { tx, newDocId }
}

/**
 * Sets up adminDb.batch with a fresh mock returned on every call.
 * Returns a getter so individual tests can inspect the batch that was created.
 */
function wireBatch() {
  const mockBatch = {
    set: vi.fn(),
    update: vi.fn(),
    commit: vi.fn().mockResolvedValue(undefined),
  }
  vi.mocked(adminDb.batch).mockReturnValue(mockBatch as never)
  return () => mockBatch
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getVerifiedSession).mockResolvedValue(ADMIN_SESSION)
  wireBatch()
})

// ── Auth guard ────────────────────────────────────────────────────────────────

describe('auth guard', () => {
  it('returns { error: "Unauthorized" } for non-admin and never calls Firestore', async () => {
    vi.mocked(getVerifiedSession).mockResolvedValue(NON_ADMIN_SESSION)

    const result = await createEquipmentWithUnits(VALID_FIELDS, [])

    expect(result).toEqual({ error: 'Unauthorized' })
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
    expect(adminDb.batch).not.toHaveBeenCalled()
  })

  it('returns { error: "Unauthorized" } for crew role', async () => {
    vi.mocked(getVerifiedSession).mockResolvedValue({
      ...ADMIN_SESSION,
      role: 'crew' as const,
    })

    const result = await createEquipmentWithUnits(VALID_FIELDS, [])

    expect(result).toEqual({ error: 'Unauthorized' })
  })
})

// ── Input validation ──────────────────────────────────────────────────────────

describe('input validation', () => {
  describe('name', () => {
    it('rejects an empty name', async () => {
      const result = await createEquipmentWithUnits({ ...VALID_FIELDS, name: '' }, [])

      expect(result).toEqual({ error: 'Name is required' })
    })

    it('rejects a whitespace-only name', async () => {
      const result = await createEquipmentWithUnits({ ...VALID_FIELDS, name: '   ' }, [])

      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('Name')
    })

    it('rejects a name longer than 100 characters', async () => {
      const result = await createEquipmentWithUnits(
        { ...VALID_FIELDS, name: 'x'.repeat(101) },
        [],
      )

      expect(result).toEqual({ error: 'Name must be 100 characters or fewer' })
    })

    it('accepts a name of exactly 100 characters (boundary)', async () => {
      wireCreateEquipmentTransaction('active', 'starter', 25, 0)

      const result = await createEquipmentWithUnits(
        { ...VALID_FIELDS, name: 'x'.repeat(100) },
        [],
      )

      expect(result).not.toHaveProperty('error')
    })
  })

  describe('category', () => {
    it('rejects an empty category', async () => {
      const result = await createEquipmentWithUnits({ ...VALID_FIELDS, category: '' }, [])

      expect(result).toEqual({ error: 'Category is required' })
    })
  })

  describe('totalQuantity', () => {
    it('rejects totalQuantity < 1 for quantity-tracked items', async () => {
      const result = await createEquipmentWithUnits(
        { ...VALID_FIELDS, trackingType: 'quantity', totalQuantity: 0 },
        [],
      )

      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('totalQuantity')
    })

    it('rejects negative totalQuantity for quantity-tracked items', async () => {
      const result = await createEquipmentWithUnits(
        { ...VALID_FIELDS, trackingType: 'quantity', totalQuantity: -1 },
        [],
      )

      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('totalQuantity')
    })
  })

  describe('unit label', () => {
    it('rejects a unit with an empty label', async () => {
      const result = await createEquipmentWithUnits(VALID_FIELDS, [
        { ...VALID_UNIT, label: '' },
      ])

      expect(result).toEqual({ error: 'Unit label is required' })
    })

    it('rejects a unit with a whitespace-only label', async () => {
      const result = await createEquipmentWithUnits(VALID_FIELDS, [
        { ...VALID_UNIT, label: '   ' },
      ])

      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('label')
    })
  })

  describe('unit status', () => {
    it('rejects a unit with an invalid status value', async () => {
      const result = await createEquipmentWithUnits(VALID_FIELDS, [
        { ...VALID_UNIT, status: 'broken' as never },
      ])

      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('status')
    })

    it('accepts all valid status values', async () => {
      const validStatuses = ['ok', 'needs_repair', 'limited_operations'] as const

      for (const status of validStatuses) {
        vi.clearAllMocks()
        vi.mocked(getVerifiedSession).mockResolvedValue(ADMIN_SESSION)
        wireBatch()
        wireCreateEquipmentTransaction('active', 'starter', 25, 0)

        const result = await createEquipmentWithUnits(VALID_FIELDS, [
          { ...VALID_UNIT, status },
        ])

        // Should not be a validation error about status
        if ('error' in result) {
          expect((result as { error: string }).error).not.toContain('status')
        }
      }
    })
  })
})

// ── Plan limit enforcement ────────────────────────────────────────────────────

describe('plan limit enforcement', () => {
  it('blocks creation when current count equals the plan limit', async () => {
    wireCreateEquipmentTransaction('active', 'starter', 25, 25)

    const result = await createEquipmentWithUnits(VALID_FIELDS, [])

    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('Equipment limit reached')
    expect((result as { error: string }).error).toContain('starter')
    expect((result as { error: string }).error).toContain('25')
  })

  it('blocks creation when current count exceeds the plan limit', async () => {
    wireCreateEquipmentTransaction('active', 'starter', 25, 26)

    const result = await createEquipmentWithUnits(VALID_FIELDS, [])

    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('Equipment limit reached')
  })

  it('blocks creation when subscription is past_due', async () => {
    wireCreateEquipmentTransaction('past_due', 'starter', 25, 0)

    const result = await createEquipmentWithUnits(VALID_FIELDS, [])

    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('Subscription')
  })

  it('blocks creation when subscription is canceled', async () => {
    wireCreateEquipmentTransaction('canceled', 'starter', 25, 0)

    const result = await createEquipmentWithUnits(VALID_FIELDS, [])

    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('Subscription')
  })

  it('allows creation when subscription is trialing and under limit', async () => {
    const { newDocId } = wireCreateEquipmentTransaction('trialing', 'starter', 25, 0)

    const result = await createEquipmentWithUnits(VALID_FIELDS, [])

    expect(result).toEqual({ id: newDocId })
  })
})

// ── Happy path — no units ─────────────────────────────────────────────────────

describe('happy path — no units', () => {
  it('runs the transaction and returns { id: newEquipmentId }', async () => {
    const { newDocId } = wireCreateEquipmentTransaction('active', 'starter', 25, 10)

    const result = await createEquipmentWithUnits(VALID_FIELDS, [])

    expect(result).toEqual({ id: newDocId })
    expect(adminDb.runTransaction).toHaveBeenCalledOnce()
  })

  it('does not call batch.set when no units are provided', async () => {
    wireCreateEquipmentTransaction('active', 'starter', 25, 10)
    const getBatch = wireBatch()

    await createEquipmentWithUnits(VALID_FIELDS, [])

    expect(getBatch().set).not.toHaveBeenCalled()
  })

  it('writes equipment fields inside the transaction', async () => {
    const { tx } = wireCreateEquipmentTransaction('active', 'starter', 25, 0)

    await createEquipmentWithUnits(VALID_FIELDS, [])

    expect(tx.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: 'ARRI Alexa Mini LF',
        category: 'Camera',
        requiresApproval: false,
        active: true,
      }),
    )
  })

  it('allows creation at exactly one below the plan limit (boundary)', async () => {
    // limit = 5, current = 4 — should succeed
    const { newDocId } = wireCreateEquipmentTransaction('active', 'starter', 25, 24)

    const result = await createEquipmentWithUnits(VALID_FIELDS, [])

    expect(result).toEqual({ id: newDocId })
  })
})

// ── Happy path — with units ───────────────────────────────────────────────────

describe('happy path — with units', () => {
  it('returns { id } after transaction and batch complete', async () => {
    const { newDocId } = wireCreateEquipmentTransaction('active', 'starter', 25, 0)
    const getBatch = wireBatch()

    const result = await createEquipmentWithUnits(VALID_FIELDS, [VALID_UNIT])

    expect(result).toEqual({ id: newDocId })
    expect(getBatch().commit).toHaveBeenCalledOnce()
  })

  it('calls batch.set once per unit with denormalized equipmentId and companyId', async () => {
    const { newDocId } = wireCreateEquipmentTransaction('active', 'starter', 25, 0)
    const getBatch = wireBatch()

    await createEquipmentWithUnits(VALID_FIELDS, [VALID_UNIT])

    expect(getBatch().set).toHaveBeenCalledTimes(1)
    expect(getBatch().set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        equipmentId: newDocId,
        companyId: COMPANY_ID,
        label: VALID_UNIT.label,
        status: VALID_UNIT.status,
        active: true,
      }),
    )
  })

  it('calls batch.set once per unit when multiple units are provided', async () => {
    wireCreateEquipmentTransaction('active', 'starter', 25, 0)
    const getBatch = wireBatch()

    const units = [
      { ...VALID_UNIT, label: 'Alexa #1' },
      { ...VALID_UNIT, label: 'Alexa #2', status: 'ok' as const },
      { ...VALID_UNIT, label: 'Alexa #3', status: 'needs_repair' as const },
    ]

    await createEquipmentWithUnits(VALID_FIELDS, units)

    expect(getBatch().set).toHaveBeenCalledTimes(3)
  })

  it('persists the correct label and status for each unit in the batch', async () => {
    wireCreateEquipmentTransaction('active', 'starter', 25, 0)
    const getBatch = wireBatch()

    const units = [
      { ...VALID_UNIT, label: 'Alexa #1', status: 'ok' as const },
      { ...VALID_UNIT, label: 'Alexa #2', status: 'needs_repair' as const },
    ]

    await createEquipmentWithUnits(VALID_FIELDS, units)

    const calls = getBatch().set.mock.calls as Array<[unknown, Record<string, unknown>]>
    const writtenLabels = calls.map(([, data]) => data.label)
    const writtenStatuses = calls.map(([, data]) => data.status)

    expect(writtenLabels).toContain('Alexa #1')
    expect(writtenLabels).toContain('Alexa #2')
    expect(writtenStatuses).toContain('ok')
    expect(writtenStatuses).toContain('needs_repair')
  })

  it('does not call batch.commit when no units are created', async () => {
    wireCreateEquipmentTransaction('active', 'starter', 25, 0)
    const getBatch = wireBatch()

    await createEquipmentWithUnits(VALID_FIELDS, [])

    expect(getBatch().commit).not.toHaveBeenCalled()
  })
})

// ── Error handling ────────────────────────────────────────────────────────────

describe('error handling', () => {
  it('returns { error } when batch.commit throws and does not leak internal details', async () => {
    wireCreateEquipmentTransaction('active', 'starter', 25, 0)

    const leakyBatch = {
      set: vi.fn(),
      update: vi.fn(),
      commit: vi.fn().mockRejectedValue(new Error('Firestore quota exceeded — internal trace')),
    }
    vi.mocked(adminDb.batch).mockReturnValue(leakyBatch as never)

    const result = await createEquipmentWithUnits(VALID_FIELDS, [VALID_UNIT])

    expect(result).toHaveProperty('error')
    const { error } = result as { error: string }
    expect(error).toBeTruthy()
    // Internal Firestore details must not surface to the caller
    expect(error).not.toContain('quota')
    expect(error).not.toContain('Firestore')
    expect(error).not.toContain('internal trace')
  })

  it('handles non-Error rejection from batch.commit gracefully', async () => {
    wireCreateEquipmentTransaction('active', 'starter', 25, 0)

    const leakyBatch = {
      set: vi.fn(),
      update: vi.fn(),
      commit: vi.fn().mockRejectedValue('network error string'),
    }
    vi.mocked(adminDb.batch).mockReturnValue(leakyBatch as never)

    const result = await createEquipmentWithUnits(VALID_FIELDS, [VALID_UNIT])

    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toBeTruthy()
  })

  it('returns { error } when the transaction itself throws', async () => {
    vi.mocked(adminDb.runTransaction).mockRejectedValue(new Error('UNAVAILABLE: upstream connect error'))

    const result = await createEquipmentWithUnits(VALID_FIELDS, [])

    expect(result).toHaveProperty('error')
    const { error } = result as { error: string }
    expect(error).not.toContain('UNAVAILABLE')
    expect(error).not.toContain('upstream')
  })
})
