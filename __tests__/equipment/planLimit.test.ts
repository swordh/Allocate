/**
 * Counter-document TOCTOU plan-limit tests — Issue #94
 *
 * ## What these tests cover
 *
 * The current code checks the active-equipment count with a `.count().get()`
 * query that runs *outside* the Firestore transaction (Firestore does not
 * support aggregation queries inside runTransaction). Two concurrent callers
 * can therefore both read count=N, both pass the limit check, and both commit
 * — landing at N+2. This is the TOCTOU (Time-Of-Check Time-Of-Use) race.
 *
 * ## The fix being tested
 *
 * A counter document lives at `companies/{companyId}/_meta/equipmentCount`
 * with shape `{ count: number }`.
 *
 * All create/deactivate operations read, check, and increment/decrement that
 * counter atomically *inside* the transaction via tx.get() / tx.update().
 * Because Firestore transactions are serialised on the server, no two
 * concurrent creates can both pass a count=N check.
 *
 * Missing counter → hard error (not a silent seed).
 *
 * ## Files under test
 *
 * - `actions/equipment.ts`          → createEquipment, createEquipmentWithUnits,
 *                                      deactivateEquipment
 *
 * ## Test status
 *
 * Tests marked with `todo` or `skip` need the fix to be implemented first;
 * they document the required behaviour but cannot pass against the current code.
 *
 * Tests NOT marked skip/todo verify behaviour that either:
 *   (a) already passes today (role guards, subscription checks), or
 *   (b) explicitly assert that the CURRENT code fails the new contract
 *       (demonstrating the bug).
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

import { createEquipment, createEquipmentWithUnits, deactivateEquipment } from '@/actions/equipment'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { wireDb, makeTransaction, type DocMap, type TransactionStub } from '../helpers/firestore'

// ── Shared fixtures ───────────────────────────────────────────────────────────

const COMPANY_ID = 'company-abc'
const EQUIPMENT_ID = 'equip-xyz'
const NEW_EQUIP_ID = 'new-equip-id'

const ADMIN_SESSION = {
  uid: 'user-admin',
  email: 'admin@example.com',
  activeCompanyId: COMPANY_ID,
  role: 'admin' as const,
}

// ── Helper: build a FormData for createEquipment ──────────────────────────────

function makeFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData()
  fd.set('name', 'Test Camera')
  fd.set('category', 'Camera')
  // One quantity item: adds exactly 1 to the counter. A `units` type adds 0 at
  // creation (its units are counted as they are added), so it cannot exercise the limit.
  fd.set('trackingType', 'quantity')
  fd.set('totalQuantity', '1')
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v)
  return fd
}

// ── Helper: valid fields for createEquipmentWithUnits ─────────────────────────

const VALID_FIELDS = {
  name: 'ARRI Alexa Mini LF',
  description: null,
  category: 'Camera',
  trackingType: 'units' as const,
  totalQuantity: 1,
  requiresApproval: false,
  approverId: null,
  customFields: [] as never[],
}

// ── Helper: wire a transaction that uses a counter document ───────────────────
//
// The new implementation will call tx.get() on TWO documents inside the
// transaction:
//   1. The company doc  → subscription / plan limits
//   2. The counter doc  → companies/{companyId}/_meta/equipmentCount
//
// tx.get() is mocked to return the correct snapshot based on the doc path.

type TxGetFn = (ref: { path: string }) => Promise<{
  exists: boolean
  data: () => Record<string, unknown>
}>

function wireTransactionWithCounter(opts: {
  subscriptionStatus: string
  plan: string
  equipmentLimit: number
  counterCount: number | null // null = missing counter doc
  counterPath?: string
}): {
  tx: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  newDocId: string
} {
  const counterPath =
    opts.counterPath ?? `companies/${COMPANY_ID}/_meta/equipmentCount`

  const txGet: TxGetFn = async (ref) => {
    if (ref.path === `companies/${COMPANY_ID}`) {
      return {
        exists: true,
        data: () => ({
          subscription: {
            status: opts.subscriptionStatus,
            plan: opts.plan,
            limits: { equipment: opts.equipmentLimit, users: 5 },
          },
        }),
      }
    }
    if (ref.path === counterPath) {
      if (opts.counterCount === null) {
        return { exists: false, data: () => ({}) }
      }
      return {
        exists: true,
        data: () => ({ count: opts.counterCount }),
      }
    }
    // Fallback: any other doc
    return { exists: false, data: () => ({}) }
  }

  const tx = {
    get: vi.fn().mockImplementation(txGet),
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

  vi.mocked(adminDb.collection).mockImplementation(() => ({
    doc: vi.fn().mockReturnValue({ id: NEW_EQUIP_ID, path: `companies/${COMPANY_ID}/equipment/${NEW_EQUIP_ID}` }),
    where: vi.fn().mockReturnValue({
      count: vi.fn().mockReturnValue({
        get: vi.fn().mockResolvedValue({ data: () => ({ count: opts.counterCount ?? 0 }) }),
      }),
    }),
  } as never))

  vi.mocked(adminDb.batch).mockReturnValue({
    set: vi.fn(),
    update: vi.fn(),
    commit: vi.fn().mockResolvedValue(undefined),
  } as never)

  return { tx, newDocId: NEW_EQUIP_ID }
}

// ── Helper: wire deactivateEquipment for the new counter-based implementation ──
//
// deactivateEquipment will need to convert its batch write to a runTransaction
// and atomically decrement the counter only when existingData.active === true.

function wireDeactivateTransaction(opts: {
  equipmentActive: boolean
  counterCount: number
  hasActiveBookings?: boolean
  /** Defaults to 'units'. `undefined` models a legacy doc written before trackingType existed. */
  trackingType?: string | null
  totalQuantity?: number
  /** Active unit documents under the type. */
  activeUnits?: number
  /** Inactive unit documents under the type — must never be counted or cascaded. */
  inactiveUnits?: number
}): {
  tx: TransactionStub
  batch: ReturnType<typeof wireDb>['batch']
} {
  const equipPath = `companies/${COMPANY_ID}/equipment/${EQUIPMENT_ID}`
  const trackingType = opts.trackingType === undefined ? 'units' : opts.trackingType

  const docs: DocMap = {
    [equipPath]: {
      active: opts.equipmentActive,
      name: 'Test Camera',
      ...(trackingType === null ? {} : { trackingType }),
      ...(opts.totalQuantity !== undefined && { totalQuantity: opts.totalQuantity }),
    },
    [`companies/${COMPANY_ID}/_meta/equipmentCount`]: { count: opts.counterCount },
  }

  const bookingDocs = opts.hasActiveBookings
    ? [{ id: 'b1', data: { status: 'confirmed', endDate: '2099-01-01' } }]
    : []
  const unitDocs = [
    ...Array.from({ length: opts.activeUnits ?? 0 }, (_, i) => ({
      id: `u${i}`,
      path: `${equipPath}/units/u${i}`,
      data: { active: true },
    })),
    ...Array.from({ length: opts.inactiveUnits ?? 0 }, (_, i) => ({
      id: `x${i}`,
      path: `${equipPath}/units/x${i}`,
      data: { active: false },
    })),
  ]

  const wired = wireDb(adminDb as unknown as Record<string, unknown>, {
    docs,
    query: (ctx) => {
      if (ctx.path === `${equipPath}/units`) {
        // Honour where('active', '==', X) like Firestore does, so dropping the
        // filter from production code changes what comes back.
        const active = ctx.filters.find((f) => f.field === 'active' && f.op === '==')
        return active ? unitDocs.filter((u) => u.data.active === active.value) : unitDocs
      }
      if (ctx.path === `companies/${COMPANY_ID}/bookings`) return bookingDocs
      return []
    },
  })

  const tx = makeTransaction(docs)
  vi.mocked(adminDb.runTransaction).mockImplementation(((cb: (t: unknown) => unknown) => cb(tx)) as never)

  return { tx, batch: wired.batch }
}

/** The counter increment a transaction wrote, or null when it never touched the counter. */
function counterDelta(tx: { update: ReturnType<typeof vi.fn> }): number | null {
  const call = tx.update.mock.calls.find(
    ([ref]) => (ref as { path: string }).path === `companies/${COMPANY_ID}/_meta/equipmentCount`,
  )
  return call ? (call[1] as { count: { operand: number } }).count.operand : null
}

// ═════════════════════════════════════════════════════════════════════════════
// createEquipment — Server Action
// ═════════════════════════════════════════════════════════════════════════════

describe('createEquipment — counter document plan limit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getVerifiedSession).mockResolvedValue(ADMIN_SESSION)
  })

  // ── count = N-1 (one slot left) ───────────────────────────────────────────

  it('succeeds when counter document shows count=N-1 (one slot remaining) and increments counter and mirror', async () => {
    // counter=24, limit=25 → should create and increment counter to 25
    const { tx } = wireTransactionWithCounter({
      subscriptionStatus: 'active',
      plan: 'starter',
      equipmentLimit: 25,
      counterCount: 24,
    })

    const result = await createEquipment(makeFormData())

    expect(result).toEqual({ id: NEW_EQUIP_ID })
    // Counter must be incremented inside the transaction
    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: `companies/${COMPANY_ID}/_meta/equipmentCount` }),
      expect.objectContaining({ count: expect.any(Object) }), // FieldValue.increment(1)
    )
    // …and the company mirror in the same transaction
    expect(tx.set).toHaveBeenCalledWith(
      expect.objectContaining({ path: `companies/${COMPANY_ID}` }),
      expect.objectContaining({
        stats: expect.objectContaining({ equipmentCount: expect.any(Object) }),
      }),
      { merge: true },
    )
  })

  // ── count = N (at limit) ──────────────────────────────────────────────────

  it('returns plan limit error when counter document shows count=N and writes neither counter nor mirror', async () => {
    // counter=25, limit=25 → should block and leave counter unchanged
    const { tx } = wireTransactionWithCounter({
      subscriptionStatus: 'active',
      plan: 'starter',
      equipmentLimit: 25,
      counterCount: 25,
    })

    const result = await createEquipment(makeFormData())

    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('Equipment limit reached')
    expect((result as { error: string }).error).toContain('starter')
    expect((result as { error: string }).error).toContain('25')
    // Counter must NOT be touched when the limit check fails
    expect(tx.update).not.toHaveBeenCalled()
    // Nor may the failure path leak a mirror write
    expect(tx.set).not.toHaveBeenCalled()
  })

  // ── Missing counter doc → hard error ─────────────────────────────────────

  it.todo(
    'returns a hard error when the counter document is missing (not a silent seed)',
    async () => {
      wireTransactionWithCounter({
        subscriptionStatus: 'active',
        plan: 'starter',
        equipmentLimit: 25,
        counterCount: null, // missing
      })

      const result = await createEquipment(makeFormData())

      // Must NOT silently seed the counter and proceed
      expect(result).toHaveProperty('error')
      const { error } = result as { error: string }
      // Should not be a limit-reached message — it's a configuration error
      expect(error).not.toContain('Equipment limit reached')
      // Should not return a new equipment id
      expect(result).not.toHaveProperty('id')
    },
  )

  // ── Concurrent simulation ─────────────────────────────────────────────────
  //
  // Two simultaneous calls both observe count=N-1 (limit=N) in the naive
  // implementation. With the counter-document fix, Firestore serialises the
  // two transactions: the second tx re-reads count=N (after the first commit)
  // and must fail.
  //
  // We simulate this by making runTransaction invoke the callback twice with
  // progressively stale state for the second invocation.

  it.todo(
    'concurrent simulation: only first call succeeds when counter is read-check-incremented atomically',
    async () => {
      // Both calls start with counter=24, limit=25.
      // First commit sets counter=25.
      // Second tx re-reads counter=25 → must fail.
      let callCount = 0

      const counterPath = `companies/${COMPANY_ID}/_meta/equipmentCount`

      vi.mocked(adminDb.runTransaction).mockImplementation(
        (async (cb: (tx: unknown) => Promise<unknown>) => {
          callCount++
          const currentCount = callCount === 1 ? 24 : 25 // second call sees updated counter

          const tx = {
            get: vi.fn().mockImplementation(async (ref: { path: string }) => {
              if (ref.path === `companies/${COMPANY_ID}`) {
                return {
                  exists: true,
                  data: () => ({
                    subscription: {
                      status: 'active',
                      plan: 'starter',
                      limits: { equipment: 25, users: 5 },
                    },
                  }),
                }
              }
              if (ref.path === counterPath) {
                return { exists: true, data: () => ({ count: currentCount }) }
              }
              return { exists: false, data: () => ({}) }
            }),
            set: vi.fn(),
            update: vi.fn(),
          }

          await cb(tx)
        }) as never,
      )

      vi.mocked(adminDb.doc).mockImplementation((path: string) => ({
        path,
        id: path.split('/').pop(),
      } as never))

      vi.mocked(adminDb.collection).mockImplementation(() => ({
        doc: vi.fn().mockReturnValue({ id: NEW_EQUIP_ID, path: `companies/${COMPANY_ID}/equipment/${NEW_EQUIP_ID}` }),
      } as never))

      vi.mocked(adminDb.batch).mockReturnValue({
        set: vi.fn(),
        update: vi.fn(),
        commit: vi.fn().mockResolvedValue(undefined),
      } as never)

      const [result1, result2] = await Promise.all([
        createEquipment(makeFormData()),
        createEquipment(makeFormData()),
      ])

      const successes = [result1, result2].filter((r) => 'id' in r)
      const failures = [result1, result2].filter((r) => 'error' in r)

      expect(successes).toHaveLength(1)
      expect(failures).toHaveLength(1)
      expect((failures[0] as { error: string }).error).toContain('Equipment limit reached')
    },
  )

  // ── Confirm the TOCTOU bug is fixed ─────────────────────────────────────
  //
  // Previously both concurrent callers would succeed (demonstrating the TOCTOU
  // bug). With the counter document fix, Firestore serialises transactions so
  // the second call sees count=N and is rejected.
  //
  // We simulate this by making runTransaction present progressively stale state:
  // the first invocation sees count=24, the second sees count=25.

  it('FIX VERIFIED: only first concurrent caller succeeds when counter read-check-increment is atomic', async () => {
    let callCount = 0
    const counterPath = `companies/${COMPANY_ID}/_meta/equipmentCount`

    vi.mocked(adminDb.runTransaction).mockImplementation(
      (async (cb: (tx: unknown) => Promise<unknown>) => {
        callCount++
        const currentCount = callCount === 1 ? 24 : 25 // second call sees updated counter

        const tx = {
          get: vi.fn().mockImplementation(async (ref: { path: string }) => {
            if (ref.path === `companies/${COMPANY_ID}`) {
              return {
                exists: true,
                data: () => ({
                  subscription: {
                    status: 'active',
                    plan: 'starter',
                    limits: { equipment: 25, users: 5 },
                  },
                }),
              }
            }
            if (ref.path === counterPath) {
              return { exists: true, data: () => ({ count: currentCount }) }
            }
            return { exists: false, data: () => ({}) }
          }),
          set: vi.fn(),
          update: vi.fn(),
        }

        await cb(tx)
      }) as never,
    )

    vi.mocked(adminDb.doc).mockImplementation((path: string) => ({
      path,
      id: path.split('/').pop(),
    } as never))

    vi.mocked(adminDb.collection).mockImplementation(() => ({
      doc: vi.fn().mockReturnValue({ id: NEW_EQUIP_ID, path: `companies/${COMPANY_ID}/equipment/${NEW_EQUIP_ID}` }),
    } as never))

    vi.mocked(adminDb.batch).mockReturnValue({
      set: vi.fn(),
      update: vi.fn(),
      commit: vi.fn().mockResolvedValue(undefined),
    } as never)

    const [result1, result2] = await Promise.all([
      createEquipment(makeFormData()),
      createEquipment(makeFormData()),
    ])

    const successes = [result1, result2].filter((r) => 'id' in r)
    const failures = [result1, result2].filter((r) => 'error' in r)

    // FIX: only one succeeds, the other is rejected by the counter check
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect((failures[0] as { error: string }).error).toContain('Equipment limit reached')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// createEquipmentWithUnits — Server Action
// ═════════════════════════════════════════════════════════════════════════════

describe('createEquipmentWithUnits — counter document plan limit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getVerifiedSession).mockResolvedValue(ADMIN_SESSION)
  })

  it.todo(
    'succeeds when counter shows count=N-1 and atomically increments counter',
    async () => {
      const { tx } = wireTransactionWithCounter({
        subscriptionStatus: 'active',
        plan: 'starter',
        equipmentLimit: 25,
        counterCount: 24,
      })

      const result = await createEquipmentWithUnits(VALID_FIELDS, [])

      expect(result).toEqual({ id: NEW_EQUIP_ID })
      expect(tx.update).toHaveBeenCalledWith(
        expect.objectContaining({ path: `companies/${COMPANY_ID}/_meta/equipmentCount` }),
        expect.objectContaining({ count: expect.any(Object) }),
      )
    },
  )

  it.todo(
    'returns plan limit error when counter shows count=N and leaves counter unchanged',
    async () => {
      const { tx } = wireTransactionWithCounter({
        subscriptionStatus: 'active',
        plan: 'starter',
        equipmentLimit: 25,
        counterCount: 25,
      })

      const result = await createEquipmentWithUnits(VALID_FIELDS, [])

      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('Equipment limit reached')
      expect(tx.update).not.toHaveBeenCalled()
    },
  )

  it.todo(
    'returns hard error when counter document is missing',
    async () => {
      wireTransactionWithCounter({
        subscriptionStatus: 'active',
        plan: 'starter',
        equipmentLimit: 25,
        counterCount: null,
      })

      const result = await createEquipmentWithUnits(VALID_FIELDS, [])

      expect(result).toHaveProperty('error')
      expect(result).not.toHaveProperty('id')
      expect((result as { error: string }).error).not.toContain('Equipment limit reached')
    },
  )
})

// ═════════════════════════════════════════════════════════════════════════════
// deactivateEquipment — Server Action
// ═════════════════════════════════════════════════════════════════════════════

describe('deactivateEquipment — counter document decrement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getVerifiedSession).mockResolvedValue(ADMIN_SESSION)
  })

  // ── Active-booking guard ──────────────────────────────────────────────────
  //
  // The guard used to test for a 'ready' status, which has never existed (see
  // types/booking.ts). Every confirmed booking slipped through it, so equipment
  // booked for next week deleted silently.

  it('requires force when a confirmed booking still references the equipment', async () => {
    wireDeactivateTransaction({
      equipmentActive: true,
      counterCount: 5,
      hasActiveBookings: true,
    })

    const result = await deactivateEquipment(EQUIPMENT_ID)

    expect(result).toEqual({ requiresForce: true, affectedBookingCount: 1 })
  })

  it('deletes without asking when force is passed', async () => {
    wireDeactivateTransaction({
      equipmentActive: true,
      counterCount: 5,
      hasActiveBookings: true,
    })

    const result = await deactivateEquipment(EQUIPMENT_ID, true)

    expect(result).toEqual({ success: true })
  })

  // ── Active equipment: decrement counter ───────────────────────────────────

  it('atomically decrements both the counter and the company mirror when deactivating active equipment', async () => {
    // Active type with one active unit → counter should decrement from 5 to 4
    const { tx } = wireDeactivateTransaction({
      equipmentActive: true,
      counterCount: 5,
      activeUnits: 1,
    })

    const result = await deactivateEquipment(EQUIPMENT_ID)

    expect(result).toEqual({ success: true })
    // Counter must be decremented inside the transaction
    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: `companies/${COMPANY_ID}/_meta/equipmentCount` }),
      expect.objectContaining({ count: expect.any(Object) }), // FieldValue.increment(-activeUnits)
    )
    // The mirror on the company document must move in the same transaction.
    // The pairing is the assertion — either both move or the two disagree.
    expect(tx.set).toHaveBeenCalledWith(
      expect.objectContaining({ path: `companies/${COMPANY_ID}` }),
      expect.objectContaining({
        stats: expect.objectContaining({ equipmentCount: expect.any(Object) }),
      }),
      { merge: true },
    )
  })

  // ── Already-inactive equipment: idempotent, no decrement ──────────────────

  it('does NOT touch counter or mirror when equipment is already inactive (idempotent)', async () => {
    // Equipment is already inactive → neither value may change
    const { tx } = wireDeactivateTransaction({
      equipmentActive: false,
      counterCount: 4,
    })

    const result = await deactivateEquipment(EQUIPMENT_ID)

    // Should succeed (idempotent) but not touch the counter
    expect(result).toEqual({ success: true })
    // Counter update call should NOT include the counter path
    const counterUpdateCalls = tx.update.mock.calls.filter(
      (args: unknown[]) => (args[0] as { path?: string })?.path?.includes('_meta/equipmentCount'),
    )
    expect(counterUpdateCalls).toHaveLength(0)
    // The mirror must be skipped by the same guard, or it drifts on repeated
    // deactivation of an item that was already inactive.
    const mirrorCalls = tx.set.mock.calls.filter(
      (args: unknown[]) => (args[0] as { path?: string })?.path === `companies/${COMPANY_ID}`,
    )
    expect(mirrorCalls).toHaveLength(0)
  })

  // ── Idempotency guard: active===false on re-read inside tx ────────────────
  //
  // The guard must live *inside* the transaction. If the equipment was active
  // when first observed outside the tx but already deactivated by the time the
  // tx read runs, the decrement must be skipped.

  it.todo(
    'skips counter decrement when equipment reads as inactive inside the transaction (concurrent deactivation)',
    async () => {
      // Simulate: equipment was "active" when the outer existence check ran,
      // but by the time the transaction reads it the document is already inactive.
      const counterPath = `companies/${COMPANY_ID}/_meta/equipmentCount`
      const equipPath = `companies/${COMPANY_ID}/equipment/${EQUIPMENT_ID}`

      const tx = {
        get: vi.fn().mockImplementation(async (ref: { path: string }) => {
          if (ref.path === equipPath) {
            // Inside the tx: equipment is already inactive (concurrent caller won)
            return { exists: true, data: () => ({ active: false, name: 'Camera', trackingType: 'individual' }) }
          }
          if (ref.path === counterPath) {
            return { exists: true, data: () => ({ count: 4 }) }
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

      vi.mocked(adminDb.collection).mockImplementation(() => ({
        where: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockResolvedValue({ docs: [] }),
          }),
          get: vi.fn().mockResolvedValue({ docs: [] }),
        }),
        doc: vi.fn().mockReturnValue({ path: `companies/${COMPANY_ID}`, id: COMPANY_ID, collection: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue({ docs: [] }) }) }) }),
      } as never))

      vi.mocked(adminDb.batch).mockReturnValue({
        set: vi.fn(),
        update: vi.fn(),
        commit: vi.fn().mockResolvedValue(undefined),
      } as never)

      const result = await deactivateEquipment(EQUIPMENT_ID)

      expect(result).toEqual({ success: true })
      const counterUpdates = tx.update.mock.calls.filter(
        (args: unknown[]) => (args[0] as { path?: string })?.path?.includes('_meta/equipmentCount'),
      )
      expect(counterUpdates).toHaveLength(0)
    },
  )

  // ── Fixed: deactivateEquipment now uses runTransaction, not batch ─────────
  //
  // This test confirms that the fix (issue #94) is in place: deactivateEquipment
  // now uses runTransaction so the counter decrement is atomic.

  it('FIX VERIFIED: deactivateEquipment now uses runTransaction (not batch) for atomic counter decrement', async () => {
    const { tx } = wireDeactivateTransaction({
      equipmentActive: true,
      counterCount: 5,
      activeUnits: 1,
    })

    const result = await deactivateEquipment(EQUIPMENT_ID)

    expect(result).toEqual({ success: true })
    // Fix: runTransaction is called, not batch
    expect(adminDb.runTransaction).toHaveBeenCalled()
    // Counter must be decremented inside the transaction
    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: `companies/${COMPANY_ID}/_meta/equipmentCount` }),
      expect.objectContaining({ count: expect.any(Object) }), // FieldValue.increment(-activeUnits)
    )
  })

  // ── How much a type takes off the counter ─────────────────────────────────

  it('subtracts every active unit under the type, not one', async () => {
    const { tx } = wireDeactivateTransaction({ equipmentActive: true, counterCount: 10, activeUnits: 3 })

    await deactivateEquipment(EQUIPMENT_ID)

    expect(counterDelta(tx)).toBe(-3)
  })

  it('ignores inactive units: counts and cascades only the active ones', async () => {
    const { tx, batch } = wireDeactivateTransaction({
      equipmentActive: true,
      counterCount: 10,
      activeUnits: 2,
      inactiveUnits: 3,
    })

    await deactivateEquipment(EQUIPMENT_ID)

    expect(counterDelta(tx)).toBe(-2)
    expect(batch.update).toHaveBeenCalledTimes(2)
  })

  it('cascades more than one batch worth of units in chunks', async () => {
    const { batch } = wireDeactivateTransaction({ equipmentActive: true, counterCount: 2000, activeUnits: 1000 })

    const result = await deactivateEquipment(EQUIPMENT_ID)

    expect(result).toEqual({ success: true })
    expect(batch.update).toHaveBeenCalledTimes(1000)
    expect(batch.commit).toHaveBeenCalledTimes(3) // 450 + 450 + 100
  })

  it('rejects an id containing a slash before touching Firestore', async () => {
    const result = await deactivateEquipment('E/units/U')

    expect(result).toEqual({ error: 'equipmentId is required' })
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
  })

  it('does not leak raw Firestore errors', async () => {
    wireDeactivateTransaction({ equipmentActive: true, counterCount: 5 })
    vi.mocked(adminDb.runTransaction).mockRejectedValue(new Error('5 NOT_FOUND: internal path details'))

    const result = await deactivateEquipment(EQUIPMENT_ID)

    expect(result).toEqual({ error: expect.not.stringContaining('NOT_FOUND') })
  })

  it('subtracts totalQuantity for a quantity-tracked type', async () => {
    const { tx, batch } = wireDeactivateTransaction({
      equipmentActive: true,
      counterCount: 12,
      trackingType: 'quantity',
      totalQuantity: 7,
    })

    await deactivateEquipment(EQUIPMENT_ID)

    expect(counterDelta(tx)).toBe(-7)
    // a quantity type has no unit documents to cascade to
    expect(batch.update).not.toHaveBeenCalled()
  })

  it('treats a legacy type without trackingType as units: counts and cascades its active units', async () => {
    const { tx, batch } = wireDeactivateTransaction({
      equipmentActive: true,
      counterCount: 6,
      trackingType: null,
      activeUnits: 2,
    })

    await deactivateEquipment(EQUIPMENT_ID)

    expect(counterDelta(tx)).toBe(-2)
    expect(batch.update).toHaveBeenCalledTimes(2)
    expect(batch.commit).toHaveBeenCalledOnce()
  })

  it('still deactivates a type when the plan is over its limit (count 40, limit 25)', async () => {
    const { tx } = wireDeactivateTransaction({ equipmentActive: true, counterCount: 40, activeUnits: 3 })

    const result = await deactivateEquipment(EQUIPMENT_ID)

    expect(result).toEqual({ success: true })
    expect(counterDelta(tx)).toBe(-3)
  })

  it('writes no counter change for a units type with no active units', async () => {
    const { tx } = wireDeactivateTransaction({ equipmentActive: true, counterCount: 4, activeUnits: 0 })

    await deactivateEquipment(EQUIPMENT_ID)

    expect(counterDelta(tx)).toBeNull()
  })

  it('does not subtract anything for an already-inactive quantity type', async () => {
    const { tx } = wireDeactivateTransaction({
      equipmentActive: false,
      counterCount: 4,
      trackingType: 'quantity',
      totalQuantity: 7,
    })

    await deactivateEquipment(EQUIPMENT_ID)

    expect(counterDelta(tx)).toBeNull()
  })

  it('fails with the backfill message when the counter document is missing, writing nothing', async () => {
    const { tx } = wireDeactivateTransaction({ equipmentActive: true, counterCount: 4, activeUnits: 1 })
    // wire a counter-less company
    const missing = makeTransaction({ [`companies/${COMPANY_ID}/equipment/${EQUIPMENT_ID}`]: { active: true, trackingType: 'units' } })
    vi.mocked(adminDb.runTransaction).mockImplementation(((cb: (t: unknown) => unknown) => cb(missing)) as never)

    const result = await deactivateEquipment(EQUIPMENT_ID)

    expect(result).toEqual({ error: expect.stringContaining('backfill') })
    expect(missing.update).not.toHaveBeenCalled()
    expect(tx.update).not.toHaveBeenCalled()
  })
})
