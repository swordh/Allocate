/**
 * Tests for toggleEquipmentAvailability server action.
 *
 * The action must:
 *   - Require admin role
 *   - Accept equipmentId: string and available: boolean
 *   - Update `availableForBooking` on the Firestore document
 *   - Call revalidatePath('/equipment')
 *   - Return {} on success or { error: string } on failure
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

import { toggleEquipmentAvailability } from '@/actions/equipment'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { revalidatePath } from 'next/cache'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID = 'company-abc'
const EQUIPMENT_ID = 'equip-xyz'

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

// Convenience: the doc ref returned by adminDb.doc()
function getDocRef() {
  return vi.mocked(adminDb.doc).mock.results[0]?.value as { get: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('toggleEquipmentAvailability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getVerifiedSession).mockResolvedValue(ADMIN_SESSION)
    // Reset the doc mock to return a fresh ref with a resolving update
    vi.mocked(adminDb.doc).mockReturnValue({
      get: vi.fn().mockResolvedValue({ exists: true }),
      update: vi.fn().mockResolvedValue(undefined),
    } as never)
  })

  // ── Role guard ──────────────────────────────────────────────────────────────

  it('returns Unauthorized for non-admin users', async () => {
    vi.mocked(getVerifiedSession).mockResolvedValue(NON_ADMIN_SESSION)

    const result = await toggleEquipmentAvailability(EQUIPMENT_ID, true)

    expect(result).toEqual({ error: 'Unauthorized' })
    expect(adminDb.doc).not.toHaveBeenCalled()
  })

  it('does not call revalidatePath when the role guard fires', async () => {
    vi.mocked(getVerifiedSession).mockResolvedValue(NON_ADMIN_SESSION)

    await toggleEquipmentAvailability(EQUIPMENT_ID, true)

    expect(revalidatePath).not.toHaveBeenCalled()
  })

  // ── Input validation ────────────────────────────────────────────────────────

  it('returns an error when equipmentId is an empty string', async () => {
    const result = await toggleEquipmentAvailability('', true)

    expect(result).toHaveProperty('error')
    expect(adminDb.doc).not.toHaveBeenCalled()
  })

  it('returns an error when equipmentId is only whitespace', async () => {
    const result = await toggleEquipmentAvailability('   ', false)

    expect(result).toHaveProperty('error')
    expect(adminDb.doc).not.toHaveBeenCalled()
  })

  // ── Successful toggle — available=true ──────────────────────────────────────

  it('updates availableForBooking to true and returns {}', async () => {
    const result = await toggleEquipmentAvailability(EQUIPMENT_ID, true)

    expect(result).toEqual({})

    const docRef = getDocRef()
    expect(docRef.update).toHaveBeenCalledOnce()

    const payload = docRef.update.mock.calls[0][0] as Record<string, unknown>
    expect(payload).toMatchObject({ availableForBooking: true })
  })

  it('targets the correct Firestore path when setting available=true', async () => {
    await toggleEquipmentAvailability(EQUIPMENT_ID, true)

    expect(adminDb.doc).toHaveBeenCalledWith(
      `companies/${COMPANY_ID}/equipment/${EQUIPMENT_ID}`,
    )
  })

  // ── Successful toggle — available=false ─────────────────────────────────────

  it('updates availableForBooking to false and returns {}', async () => {
    const result = await toggleEquipmentAvailability(EQUIPMENT_ID, false)

    expect(result).toEqual({})

    const docRef = getDocRef()
    expect(docRef.update).toHaveBeenCalledOnce()

    const payload = docRef.update.mock.calls[0][0] as Record<string, unknown>
    expect(payload).toMatchObject({ availableForBooking: false })
  })

  it('targets the correct Firestore path when setting available=false', async () => {
    await toggleEquipmentAvailability(EQUIPMENT_ID, false)

    expect(adminDb.doc).toHaveBeenCalledWith(
      `companies/${COMPANY_ID}/equipment/${EQUIPMENT_ID}`,
    )
  })

  // ── revalidatePath ──────────────────────────────────────────────────────────

  it('calls revalidatePath with /equipment on success', async () => {
    await toggleEquipmentAvailability(EQUIPMENT_ID, true)

    expect(revalidatePath).toHaveBeenCalledWith('/equipment')
  })

  it('calls revalidatePath for /equipment, /bookings, and /bookings/new on success', async () => {
    await toggleEquipmentAvailability(EQUIPMENT_ID, false)

    expect(revalidatePath).toHaveBeenCalledTimes(3)
    expect(revalidatePath).toHaveBeenCalledWith('/equipment')
    expect(revalidatePath).toHaveBeenCalledWith('/bookings')
    expect(revalidatePath).toHaveBeenCalledWith('/bookings/new')
  })

  it('does not call revalidatePath when Firestore update fails', async () => {
    vi.mocked(adminDb.doc).mockReturnValue({
      get: vi.fn().mockResolvedValue({ exists: true }),
      update: vi.fn().mockRejectedValue(new Error('write failed')),
    } as never)

    await toggleEquipmentAvailability(EQUIPMENT_ID, true)

    expect(revalidatePath).not.toHaveBeenCalled()
  })

  // ── Firestore error handling ─────────────────────────────────────────────────

  it('returns { error: string } when Firestore update throws', async () => {
    vi.mocked(adminDb.doc).mockReturnValue({
      get: vi.fn().mockResolvedValue({ exists: true }),
      update: vi.fn().mockRejectedValue(new Error('FIRESTORE_UNAVAILABLE')),
    } as never)

    const result = await toggleEquipmentAvailability(EQUIPMENT_ID, true)

    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('FIRESTORE_UNAVAILABLE')
  })

  it('returns a non-empty error string when Firestore throws a non-Error value', async () => {
    vi.mocked(adminDb.doc).mockReturnValue({
      get: vi.fn().mockResolvedValue({ exists: true }),
      update: vi.fn().mockRejectedValue('raw string rejection'),
    } as never)

    const result = await toggleEquipmentAvailability(EQUIPMENT_ID, true)

    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error.length).toBeGreaterThan(0)
  })

  it('does not propagate the Firestore exception — action always returns', async () => {
    vi.mocked(adminDb.doc).mockReturnValue({
      get: vi.fn().mockResolvedValue({ exists: true }),
      update: vi.fn().mockRejectedValue(new Error('network error')),
    } as never)

    await expect(toggleEquipmentAvailability(EQUIPMENT_ID, true)).resolves.not.toThrow()
  })
})
