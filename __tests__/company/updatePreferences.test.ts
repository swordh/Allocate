/**
 * Tests for updatePreferences server action.
 *
 * `preferences` is split across two settings screens in the redesign — timezone
 * saves from the Company tab, booking time slot from the Preferences tab. The
 * action MUST write only the dot-path keys the caller actually supplied
 * (`preferences.timezone`, `preferences.bookingTimeSlotMinutes`,
 * `preferences.autoCheckout`, `preferences.autoCheckin`) via a Firestore merge
 * `update()`, never a wholesale `{ preferences: {...} }` object — a wholesale
 * write from one screen would silently wipe the other screen's fields, plus
 * autoCheckout/autoCheckin, which drive live Cloud Functions and appear on no
 * settings screen.
 *
 * Firebase Admin, getVerifiedSession, and next/cache are mocked; no network
 * calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('@/lib/firebase-admin', () => {
  const mockCompanyDocRef = {
    update: vi.fn().mockResolvedValue(undefined),
  }
  const mockCompaniesCollection = {
    doc: vi.fn().mockReturnValue(mockCompanyDocRef),
  }
  const mockDb = {
    collection: vi.fn().mockReturnValue(mockCompaniesCollection),
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

import { updatePreferences } from '@/actions/company'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { revalidatePath } from 'next/cache'

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

// Convenience: the company doc ref returned by adminDb.collection('companies').doc()
function getCompanyDocRef() {
  const collection = vi.mocked(adminDb.collection).mock.results[0]?.value as {
    doc: ReturnType<typeof vi.fn>
  }
  return collection.doc.mock.results[0]?.value as { update: ReturnType<typeof vi.fn> }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getVerifiedSession).mockResolvedValue(ADMIN_SESSION)
  vi.mocked(adminDb.collection).mockReturnValue({
    doc: vi.fn().mockReturnValue({
      update: vi.fn().mockResolvedValue(undefined),
    }),
  } as never)
})

// ── Role guard ──────────────────────────────────────────────────────────────

describe('updatePreferences — role guard', () => {
  it('rejects a non-admin caller and performs no write', async () => {
    vi.mocked(getVerifiedSession).mockResolvedValue(NON_ADMIN_SESSION)

    const result = await updatePreferences({ timezone: 'Europe/Stockholm' })

    expect(result).toEqual({ error: 'Unauthorized' })
    expect(adminDb.collection).not.toHaveBeenCalled()
  })

  it('does not call revalidatePath when the role guard fires', async () => {
    vi.mocked(getVerifiedSession).mockResolvedValue(NON_ADMIN_SESSION)

    await updatePreferences({ bookingTimeSlotMinutes: 5 })

    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

// ── Partial save — the regression guard ─────────────────────────────────────

describe('updatePreferences — partial save writes only supplied keys', () => {
  it('a timezone-only save writes exactly preferences.timezone', async () => {
    const result = await updatePreferences({ timezone: 'Europe/Stockholm' })

    expect(result).toEqual({})

    const docRef = getCompanyDocRef()
    expect(docRef.update).toHaveBeenCalledOnce()

    const payload = docRef.update.mock.calls[0][0] as Record<string, unknown>
    expect(Object.keys(payload)).toEqual(['preferences.timezone'])
    expect(payload).toEqual({ 'preferences.timezone': 'Europe/Stockholm' })

    // Must NOT touch fields owned by other screens or the Cloud-Function-driving flags.
    expect(payload).not.toHaveProperty('preferences.autoCheckout')
    expect(payload).not.toHaveProperty('preferences.autoCheckin')
    expect(payload).not.toHaveProperty('preferences.bookingTimeSlotMinutes')
  })

  it('a time-slot-only save writes exactly preferences.bookingTimeSlotMinutes', async () => {
    const result = await updatePreferences({ bookingTimeSlotMinutes: 5 })

    expect(result).toEqual({})

    const docRef = getCompanyDocRef()
    const payload = docRef.update.mock.calls[0][0] as Record<string, unknown>
    expect(Object.keys(payload)).toEqual(['preferences.bookingTimeSlotMinutes'])
    expect(payload).toEqual({ 'preferences.bookingTimeSlotMinutes': 5 })
    expect(payload).not.toHaveProperty('preferences.timezone')
    expect(payload).not.toHaveProperty('preferences.autoCheckout')
    expect(payload).not.toHaveProperty('preferences.autoCheckin')
  })

  it('a multi-field save writes exactly the supplied dot-path keys, nothing more', async () => {
    const result = await updatePreferences({
      timezone: 'Europe/Berlin',
      autoCheckout: true,
    })

    expect(result).toEqual({})

    const docRef = getCompanyDocRef()
    const payload = docRef.update.mock.calls[0][0] as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['preferences.autoCheckout', 'preferences.timezone'])
    expect(payload).toEqual({
      'preferences.timezone': 'Europe/Berlin',
      'preferences.autoCheckout': true,
    })
    expect(payload).not.toHaveProperty('preferences.bookingTimeSlotMinutes')
    expect(payload).not.toHaveProperty('preferences.autoCheckin')
  })
})

// ── Dot paths, not a nested object ───────────────────────────────────────────

describe('updatePreferences — dot-path merge, not a wholesale write', () => {
  it('uses the dot-path key "preferences.timezone" rather than a nested { preferences: {...} } object', async () => {
    await updatePreferences({ timezone: 'Europe/Stockholm' })

    const docRef = getCompanyDocRef()
    const payload = docRef.update.mock.calls[0][0] as Record<string, unknown>

    expect(payload).toHaveProperty('preferences.timezone')
    expect(payload).not.toHaveProperty('preferences')
    // Guard against a future revert to a wholesale write, which would clobber
    // autoCheckout/autoCheckin silently since neither appears on any screen.
    expect(payload['preferences']).toBeUndefined()
  })

  it('targets companies/{activeCompanyId} via collection().doc()', async () => {
    await updatePreferences({ timezone: 'Europe/Stockholm' })

    expect(adminDb.collection).toHaveBeenCalledWith('companies')
    const collection = vi.mocked(adminDb.collection).mock.results[0]?.value as {
      doc: ReturnType<typeof vi.fn>
    }
    expect(collection.doc).toHaveBeenCalledWith(COMPANY_ID)
  })
})

// ── Invalid time slot ─────────────────────────────────────────────────────────

describe('updatePreferences — invalid bookingTimeSlotMinutes', () => {
  it('rejects a value not present in TIME_SLOT_OPTIONS and performs no write', async () => {
    // 30 is deliberately not a legal option (TIME_SLOT_OPTIONS = [1, 5, 10, 15, 60, -1]).
    const result = await updatePreferences({ bookingTimeSlotMinutes: 30 })

    expect(result).toEqual({ error: 'Invalid time slot value.' })
    expect(adminDb.collection).not.toHaveBeenCalled()
  })

  it.each([1, 5, 10, 15, 60, -1])('accepts the legal time slot value %d', async (value) => {
    const result = await updatePreferences({ bookingTimeSlotMinutes: value })

    expect(result).toEqual({})
    const docRef = getCompanyDocRef()
    const payload = docRef.update.mock.calls[0][0] as Record<string, unknown>
    expect(payload).toEqual({ 'preferences.bookingTimeSlotMinutes': value })
  })

  it('rejects a value that is close to but not a legal option (e.g. 0)', async () => {
    const result = await updatePreferences({ bookingTimeSlotMinutes: 0 })

    expect(result).toEqual({ error: 'Invalid time slot value.' })
    expect(adminDb.collection).not.toHaveBeenCalled()
  })
})

// ── Invalid timezone ─────────────────────────────────────────────────────────

describe('updatePreferences — invalid timezone', () => {
  it('rejects an unrecognised IANA timezone string and performs no write', async () => {
    const result = await updatePreferences({ timezone: 'Not/AZone' })

    expect(result).toEqual({ error: 'Invalid timezone.' })
    expect(adminDb.collection).not.toHaveBeenCalled()
  })

  it('rejects an empty string timezone', async () => {
    const result = await updatePreferences({ timezone: '' })

    expect(result).toEqual({ error: 'Invalid timezone.' })
    expect(adminDb.collection).not.toHaveBeenCalled()
  })

  it('accepts a valid IANA timezone', async () => {
    const result = await updatePreferences({ timezone: 'America/New_York' })

    expect(result).toEqual({})
    const docRef = getCompanyDocRef()
    const payload = docRef.update.mock.calls[0][0] as Record<string, unknown>
    expect(payload).toEqual({ 'preferences.timezone': 'America/New_York' })
  })
})

// ── Empty payload ─────────────────────────────────────────────────────────────

describe('updatePreferences — empty payload', () => {
  it('performs no write and returns {} for an empty object', async () => {
    const result = await updatePreferences({})

    expect(result).toEqual({})
    expect(adminDb.collection).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

// ── Firestore error handling ─────────────────────────────────────────────────

describe('updatePreferences — Firestore failure', () => {
  it('returns { error } and does not throw when update() rejects', async () => {
    vi.mocked(adminDb.collection).mockReturnValue({
      doc: vi.fn().mockReturnValue({
        update: vi.fn().mockRejectedValue(new Error('FIRESTORE_UNAVAILABLE')),
      }),
    } as never)

    const result = await updatePreferences({ timezone: 'Europe/Stockholm' })

    expect(result).toEqual({ error: 'Failed to save preferences' })
  })

  it('does not call revalidatePath when the write fails', async () => {
    vi.mocked(adminDb.collection).mockReturnValue({
      doc: vi.fn().mockReturnValue({
        update: vi.fn().mockRejectedValue(new Error('write failed')),
      }),
    } as never)

    await updatePreferences({ timezone: 'Europe/Stockholm' })

    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

// ── revalidatePath ────────────────────────────────────────────────────────────

describe('updatePreferences — revalidatePath', () => {
  it('calls revalidatePath with /settings/preferences on success', async () => {
    await updatePreferences({ timezone: 'Europe/Stockholm' })

    expect(revalidatePath).toHaveBeenCalledWith('/settings/preferences')
  })
})
