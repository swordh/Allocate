/**
 * Tests for updateCompanySettings server action — timezone coverage.
 *
 * The Company tab saves `name` and `timezone` together in one batch. `timezone`
 * must be written via the same dot-path merge used by `updatePreferences`
 * (`preferences.timezone`), batched alongside `name` on the company doc, and
 * must never touch `preferences.bookingTimeSlotMinutes`, `.autoCheckout`, or
 * `.autoCheckin` — those are owned by the Preferences screen and by live Cloud
 * Functions that appear on no settings screen.
 *
 * Firebase Admin, getVerifiedSession, and next/cache are mocked; no network
 * calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('@/lib/firebase-admin', () => {
  const mockBatch = {
    update: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    commit: vi.fn().mockResolvedValue(undefined),
  }
  const mockCategoriesCollection = {
    doc: vi.fn().mockReturnValue({}),
  }
  const mockCompanyRef = {
    collection: vi.fn().mockReturnValue(mockCategoriesCollection),
  }
  const mockCompaniesCollection = {
    doc: vi.fn().mockReturnValue(mockCompanyRef),
  }
  const mockDb = {
    collection: vi.fn().mockReturnValue(mockCompaniesCollection),
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

import { updateCompanySettings } from '@/actions/company'
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

function baseInput(overrides: Partial<Parameters<typeof updateCompanySettings>[0]> = {}) {
  return {
    name: 'Acme Rentals',
    categoryTemplates: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getVerifiedSession).mockResolvedValue(ADMIN_SESSION)

  const mockCategoriesCollection = { doc: vi.fn().mockReturnValue({}) }
  const mockCompanyRef = { collection: vi.fn().mockReturnValue(mockCategoriesCollection) }
  vi.mocked(adminDb.collection).mockReturnValue({
    doc: vi.fn().mockReturnValue(mockCompanyRef),
  } as never)
  vi.mocked(adminDb.batch).mockReturnValue({
    update: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    commit: vi.fn().mockResolvedValue(undefined),
  } as never)
})

// ── Role guard ────────────────────────────────────────────────────────────────

describe('updateCompanySettings — role guard', () => {
  it('rejects a non-admin caller and performs no write', async () => {
    vi.mocked(getVerifiedSession).mockResolvedValue(NON_ADMIN_SESSION)

    const result = await updateCompanySettings(baseInput({ timezone: 'Europe/Stockholm' }))

    expect(result).toEqual({ error: 'Unauthorized' })
    expect(adminDb.batch).not.toHaveBeenCalled()
  })
})

// ── timezone via dot-path, batched with name ─────────────────────────────────

describe('updateCompanySettings — timezone dot-path write', () => {
  it('writes preferences.timezone alongside name in the same batch.update() call', async () => {
    const result = await updateCompanySettings(baseInput({ timezone: 'Europe/Stockholm' }))

    expect(result).toEqual({})

    const batch = vi.mocked(adminDb.batch).mock.results[0]?.value as {
      update: ReturnType<typeof vi.fn>
      commit: ReturnType<typeof vi.fn>
    }

    // Exactly one batch.update() call targets the company doc (no category templates supplied).
    expect(batch.update).toHaveBeenCalledOnce()
    const payload = batch.update.mock.calls[0][1] as Record<string, unknown>

    expect(payload).toEqual({
      name: 'Acme Rentals',
      'preferences.timezone': 'Europe/Stockholm',
    })
    expect(payload).not.toHaveProperty('preferences.bookingTimeSlotMinutes')
    expect(payload).not.toHaveProperty('preferences.autoCheckout')
    expect(payload).not.toHaveProperty('preferences.autoCheckin')
    expect(payload).not.toHaveProperty('preferences')

    expect(batch.commit).toHaveBeenCalledOnce()
  })

  it('omits preferences.timezone entirely when timezone is not supplied', async () => {
    const result = await updateCompanySettings(baseInput())

    expect(result).toEqual({})

    const batch = vi.mocked(adminDb.batch).mock.results[0]?.value as {
      update: ReturnType<typeof vi.fn>
    }
    const payload = batch.update.mock.calls[0][1] as Record<string, unknown>

    expect(payload).toEqual({ name: 'Acme Rentals' })
    expect(payload).not.toHaveProperty('preferences.timezone')
  })

  it('rejects an invalid timezone and performs no write', async () => {
    const result = await updateCompanySettings(baseInput({ timezone: 'Not/AZone' }))

    expect(result).toEqual({ error: 'Invalid timezone.' })
    expect(adminDb.batch).not.toHaveBeenCalled()
  })

  it('targets companies/{activeCompanyId} for the batched update', async () => {
    await updateCompanySettings(baseInput({ timezone: 'Europe/Stockholm' }))

    expect(adminDb.collection).toHaveBeenCalledWith('companies')
    const companiesCollection = vi.mocked(adminDb.collection).mock.results[0]?.value as {
      doc: ReturnType<typeof vi.fn>
    }
    expect(companiesCollection.doc).toHaveBeenCalledWith(COMPANY_ID)
  })

  it('calls revalidatePath with /settings/company on success', async () => {
    await updateCompanySettings(baseInput({ timezone: 'Europe/Stockholm' }))

    expect(revalidatePath).toHaveBeenCalledWith('/settings/company')
  })
})

// ── Firestore error handling ─────────────────────────────────────────────────

describe('updateCompanySettings — Firestore failure', () => {
  it('returns { error } and does not throw when commit() rejects', async () => {
    vi.mocked(adminDb.batch).mockReturnValue({
      update: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      commit: vi.fn().mockRejectedValue(new Error('FIRESTORE_UNAVAILABLE')),
    } as never)

    const result = await updateCompanySettings(baseInput({ timezone: 'Europe/Stockholm' }))

    expect(result).toEqual({ error: 'Failed to save settings' })
  })
})
