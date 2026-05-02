/**
 * Tests for toggleUnitAvailability server action.
 *
 * The action must:
 *   - Require admin role (via getVerifiedSession)
 *   - Validate that both equipmentId and unitId are non-empty strings
 *   - Update `availableForBooking` on the unit document at
 *     companies/{companyId}/equipment/{equipmentId}/units/{unitId}
 *   - Call revalidatePath('/equipment'), revalidatePath('/bookings'),
 *     and revalidatePath('/bookings/new') on success
 *   - Return {} on success or { error: string } on failure
 *   - Never throw — always return
 *
 * Firebase Admin, getVerifiedSession, and next/cache are mocked;
 * no network calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('@/lib/firebase-admin', () => {
  const mockDocRef = {
    get: vi.fn().mockResolvedValue({ exists: true }),
    update: vi.fn(),
  }
  const mockDb = {
    doc: vi.fn().mockReturnValue(mockDocRef),
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

import { toggleUnitAvailability } from '@/actions/equipment'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { revalidatePath } from 'next/cache'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID = 'company-abc'
const EQUIPMENT_ID = 'equip-xyz'
const UNIT_ID = 'unit-001'

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

// Convenience: the doc ref returned by adminDb.doc() after the action calls it.
// Results accumulate per call, so index 0 is the first (and typically only) call.
function getDocRef() {
  return vi.mocked(adminDb.doc).mock.results[0]?.value as {
    get: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('toggleUnitAvailability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getVerifiedSession).mockResolvedValue(ADMIN_SESSION)
    // Provide a fresh doc ref with a resolving update for every test.
    vi.mocked(adminDb.doc).mockReturnValue({
      get: vi.fn().mockResolvedValue({ exists: true }),
      update: vi.fn().mockResolvedValue(undefined),
    } as never)
  })

  // ── Role guard ──────────────────────────────────────────────────────────────

  it('returns { error: "Unauthorized" } for non-admin users', async () => {
    vi.mocked(getVerifiedSession).mockResolvedValue(NON_ADMIN_SESSION)

    const result = await toggleUnitAvailability(EQUIPMENT_ID, UNIT_ID, true)

    expect(result).toEqual({ error: 'Unauthorized' })
  })

  it('does not call adminDb.doc when the role guard fires', async () => {
    vi.mocked(getVerifiedSession).mockResolvedValue(NON_ADMIN_SESSION)

    await toggleUnitAvailability(EQUIPMENT_ID, UNIT_ID, true)

    expect(adminDb.doc).not.toHaveBeenCalled()
  })

  it('does not call revalidatePath when the role guard fires', async () => {
    vi.mocked(getVerifiedSession).mockResolvedValue(NON_ADMIN_SESSION)

    await toggleUnitAvailability(EQUIPMENT_ID, UNIT_ID, true)

    expect(revalidatePath).not.toHaveBeenCalled()
  })

  // ── Input validation — equipmentId ──────────────────────────────────────────

  it('returns an error and skips Firestore when equipmentId is an empty string', async () => {
    const result = await toggleUnitAvailability('', UNIT_ID, true)

    expect(result).toHaveProperty('error')
    expect(adminDb.doc).not.toHaveBeenCalled()
  })

  it('returns an error and skips Firestore when equipmentId is only whitespace', async () => {
    const result = await toggleUnitAvailability('   ', UNIT_ID, false)

    expect(result).toHaveProperty('error')
    expect(adminDb.doc).not.toHaveBeenCalled()
  })

  // ── Input validation — unitId ───────────────────────────────────────────────

  it('returns an error and skips Firestore when unitId is an empty string', async () => {
    const result = await toggleUnitAvailability(EQUIPMENT_ID, '', true)

    expect(result).toHaveProperty('error')
    expect(adminDb.doc).not.toHaveBeenCalled()
  })

  it('returns an error and skips Firestore when unitId is only whitespace', async () => {
    const result = await toggleUnitAvailability(EQUIPMENT_ID, '   ', false)

    expect(result).toHaveProperty('error')
    expect(adminDb.doc).not.toHaveBeenCalled()
  })

  // ── Successful toggle — available=true ──────────────────────────────────────

  it('updates availableForBooking to true and returns {}', async () => {
    const result = await toggleUnitAvailability(EQUIPMENT_ID, UNIT_ID, true)

    expect(result).toEqual({})

    const docRef = getDocRef()
    expect(docRef.update).toHaveBeenCalledOnce()

    const payload = docRef.update.mock.calls[0][0] as Record<string, unknown>
    expect(payload).toMatchObject({ availableForBooking: true })
  })

  it('targets the correct Firestore path when setting available=true', async () => {
    await toggleUnitAvailability(EQUIPMENT_ID, UNIT_ID, true)

    expect(adminDb.doc).toHaveBeenCalledWith(
      `companies/${COMPANY_ID}/equipment/${EQUIPMENT_ID}/units/${UNIT_ID}`,
    )
  })

  // ── Successful toggle — available=false ─────────────────────────────────────

  it('updates availableForBooking to false and returns {}', async () => {
    const result = await toggleUnitAvailability(EQUIPMENT_ID, UNIT_ID, false)

    expect(result).toEqual({})

    const docRef = getDocRef()
    expect(docRef.update).toHaveBeenCalledOnce()

    const payload = docRef.update.mock.calls[0][0] as Record<string, unknown>
    expect(payload).toMatchObject({ availableForBooking: false })
  })

  it('targets the correct Firestore path when setting available=false', async () => {
    await toggleUnitAvailability(EQUIPMENT_ID, UNIT_ID, false)

    expect(adminDb.doc).toHaveBeenCalledWith(
      `companies/${COMPANY_ID}/equipment/${EQUIPMENT_ID}/units/${UNIT_ID}`,
    )
  })

  // ── revalidatePath ──────────────────────────────────────────────────────────

  it('calls revalidatePath exactly 3 times on success', async () => {
    await toggleUnitAvailability(EQUIPMENT_ID, UNIT_ID, true)

    expect(revalidatePath).toHaveBeenCalledTimes(3)
  })

  it('calls revalidatePath with /equipment on success', async () => {
    await toggleUnitAvailability(EQUIPMENT_ID, UNIT_ID, true)

    expect(revalidatePath).toHaveBeenCalledWith('/equipment')
  })

  it('calls revalidatePath with /bookings on success', async () => {
    await toggleUnitAvailability(EQUIPMENT_ID, UNIT_ID, false)

    expect(revalidatePath).toHaveBeenCalledWith('/bookings')
  })

  it('calls revalidatePath with /bookings/new on success', async () => {
    await toggleUnitAvailability(EQUIPMENT_ID, UNIT_ID, false)

    expect(revalidatePath).toHaveBeenCalledWith('/bookings/new')
  })

  it('does not call revalidatePath when Firestore update throws', async () => {
    vi.mocked(adminDb.doc).mockReturnValue({
      get: vi.fn().mockResolvedValue({ exists: true }),
      update: vi.fn().mockRejectedValue(new Error('write failed')),
    } as never)

    await toggleUnitAvailability(EQUIPMENT_ID, UNIT_ID, true)

    expect(revalidatePath).not.toHaveBeenCalled()
  })

  // ── Existence check ─────────────────────────────────────────────────────────

  it('returns { error: "Unit not found." } when the unit document does not exist', async () => {
    vi.mocked(adminDb.doc).mockReturnValue({
      get: vi.fn().mockResolvedValue({ exists: false }),
      update: vi.fn().mockResolvedValue(undefined),
    } as never)

    const result = await toggleUnitAvailability(EQUIPMENT_ID, UNIT_ID, true)

    expect(result).toEqual({ error: 'Unit not found.' })
  })

  it('does not call update or revalidatePath when the unit document does not exist', async () => {
    vi.mocked(adminDb.doc).mockReturnValue({
      get: vi.fn().mockResolvedValue({ exists: false }),
      update: vi.fn().mockResolvedValue(undefined),
    } as never)

    await toggleUnitAvailability(EQUIPMENT_ID, UNIT_ID, true)

    const docRef = getDocRef()
    expect(docRef.update).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  // ── Firestore error handling ─────────────────────────────────────────────────

  it('returns { error: string } when Firestore update throws an Error', async () => {
    vi.mocked(adminDb.doc).mockReturnValue({
      get: vi.fn().mockResolvedValue({ exists: true }),
      update: vi.fn().mockRejectedValue(new Error('FIRESTORE_UNAVAILABLE')),
    } as never)

    const result = await toggleUnitAvailability(EQUIPMENT_ID, UNIT_ID, true)

    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('FIRESTORE_UNAVAILABLE')
  })

  it('returns a non-empty error string when Firestore rejects with a non-Error value', async () => {
    vi.mocked(adminDb.doc).mockReturnValue({
      get: vi.fn().mockResolvedValue({ exists: true }),
      update: vi.fn().mockRejectedValue('raw string rejection'),
    } as never)

    const result = await toggleUnitAvailability(EQUIPMENT_ID, UNIT_ID, true)

    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error.length).toBeGreaterThan(0)
  })

  it('always resolves — the action never propagates an exception', async () => {
    vi.mocked(adminDb.doc).mockReturnValue({
      get: vi.fn().mockResolvedValue({ exists: true }),
      update: vi.fn().mockRejectedValue(new Error('network error')),
    } as never)

    await expect(
      toggleUnitAvailability(EQUIPMENT_ID, UNIT_ID, true),
    ).resolves.not.toThrow()
  })
})
