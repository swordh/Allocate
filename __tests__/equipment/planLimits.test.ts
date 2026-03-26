/**
 * Plan limit enforcement tests for createEquipment.
 *
 * The equipment limit check is the only atomic plan-limit guard exposed
 * through a public action. It lives in the Firestore transaction of
 * createEquipment: currentCount >= limit → throws resource-exhausted error.
 *
 * Firebase Admin and getVerifiedSession are mocked; no network calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

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

// ── Imports ───────────────────────────────────────────────────────────────────

import { createEquipment } from '@/actions/equipment'
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

const NON_ADMIN_SESSION = {
  uid: 'user-crew',
  email: 'crew@example.com',
  activeCompanyId: COMPANY_ID,
  role: 'crew' as const,
}

function makeFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData()
  fd.set('name', 'Test Camera')
  fd.set('category', 'Camera')
  fd.set('trackingType', 'individual')
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v)
  return fd
}

/**
 * Wire adminDb.runTransaction with a company snapshot and a count value for
 * the active equipment aggregation query.
 */
function wireCreateEquipmentTransaction(
  subscriptionStatus: string,
  plan: string,
  equipmentLimit: number,
  currentEquipmentCount: number,
) {
  const newDocId = 'new-equip-id'

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

  vi.mocked(adminDb.doc).mockImplementation((path: string) => ({
    path,
    id: path.split('/').pop(),
  } as never))

  // The equipment collection is used for:
  //   1. The count query (outside the transaction, chained: .where().count().get())
  //   2. .doc() to create the new equipment ref
  vi.mocked(adminDb.collection).mockImplementation(() => ({
    where: vi.fn().mockReturnValue({
      count: vi.fn().mockReturnValue({
        get: vi.fn().mockResolvedValue({
          data: () => ({ count: currentEquipmentCount }),
        }),
      }),
    }),
    doc: vi.fn().mockReturnValue({ id: newDocId }),
  } as never))

  return { tx, newDocId }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createEquipment — plan limit enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getVerifiedSession).mockResolvedValue(ADMIN_SESSION)
  })

  // ── Role guard ─────────────────────────────────────────────────────────────

  it('returns Unauthorized for non-admin users', async () => {
    vi.mocked(getVerifiedSession).mockResolvedValue(NON_ADMIN_SESSION)

    const result = await createEquipment(makeFormData())

    expect(result).toEqual({ error: 'Unauthorized' })
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
  })

  // ── Under limit ────────────────────────────────────────────────────────────

  it('creates equipment when current count is below the plan limit', async () => {
    const { newDocId } = wireCreateEquipmentTransaction('active', 'basic', 50, 10)

    const result = await createEquipment(makeFormData())

    expect(result).toEqual({ id: newDocId })
  })

  it('creates equipment when current count is exactly one below the limit (boundary)', async () => {
    // limit = 5, current = 4 → allowed
    const { newDocId } = wireCreateEquipmentTransaction('active', 'small', 5, 4)

    const result = await createEquipment(makeFormData())

    expect(result).toEqual({ id: newDocId })
  })

  // ── At limit ───────────────────────────────────────────────────────────────

  it('blocks creation when current count equals the plan limit', async () => {
    // limit = 5, current = 5 → blocked
    wireCreateEquipmentTransaction('active', 'small', 5, 5)

    const result = await createEquipment(makeFormData())

    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('Equipment limit reached')
    expect((result as { error: string }).error).toContain('small')
    expect((result as { error: string }).error).toContain('5')
  })

  it('blocks creation when current count exceeds the plan limit', async () => {
    // Defensive: count somehow exceeds limit (data migration scenario)
    wireCreateEquipmentTransaction('active', 'basic', 50, 51)

    const result = await createEquipment(makeFormData())

    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('Equipment limit reached')
  })

  // ── Trialing subscription ──────────────────────────────────────────────────

  it('allows creation when subscription is trialing and under limit', async () => {
    const { newDocId } = wireCreateEquipmentTransaction('trialing', 'basic', 50, 0)

    const result = await createEquipment(makeFormData())

    expect(result).toEqual({ id: newDocId })
  })

  // ── Inactive subscription ──────────────────────────────────────────────────

  it('blocks creation when subscription is past_due', async () => {
    wireCreateEquipmentTransaction('past_due', 'basic', 50, 0)

    const result = await createEquipment(makeFormData())

    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('Subscription')
  })

  it('blocks creation when subscription is canceled', async () => {
    wireCreateEquipmentTransaction('canceled', 'basic', 50, 0)

    const result = await createEquipment(makeFormData())

    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('Subscription')
  })

  // ── Input validation ───────────────────────────────────────────────────────

  describe('input validation', () => {
    it('rejects an empty name', async () => {
      const result = await createEquipment(makeFormData({ name: '' }))
      expect(result).toEqual({ error: 'Name is required' })
    })

    it('rejects a name longer than 100 characters', async () => {
      const result = await createEquipment(makeFormData({ name: 'x'.repeat(101) }))
      expect(result).toEqual({ error: 'Name must be 100 characters or fewer' })
    })

    it('rejects an empty category', async () => {
      const result = await createEquipment(makeFormData({ category: '' }))
      expect(result).toEqual({ error: 'Category is required' })
    })

    it('rejects an invalid status value', async () => {
      const result = await createEquipment(makeFormData({ status: 'broken' }))
      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('status must be one of')
    })

    it('rejects totalQuantity < 1 for quantity-tracked items', async () => {
      const result = await createEquipment(
        makeFormData({ trackingType: 'quantity', totalQuantity: '0' }),
      )
      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('totalQuantity')
    })

    it('rejects a serialNumber on a quantity-tracked item', async () => {
      const result = await createEquipment(
        makeFormData({ trackingType: 'quantity', totalQuantity: '5', serialNumber: 'SN-001' }),
      )
      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('serialNumber')
    })
  })
})
