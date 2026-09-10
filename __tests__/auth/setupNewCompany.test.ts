/**
 * Tests that a new company is born with a complete stats map.
 *
 * lastBookingAt must be written as an explicit null rather than omitted.
 * Firestore excludes documents that LACK a field from inequality queries, so a
 * company without the key would never appear in the operator's "No bookings 30 d"
 * segment — silently, with no error. Present-and-null sorts before timestamps and
 * is included.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {
    doc: vi.fn(),
    collection: vi.fn(),
    batch: vi.fn(),
  },
  adminAuth: {
    verifyIdToken: vi.fn(),
    setCustomUserClaims: vi.fn(),
  },
}))

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: vi.fn(),
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { setupNewCompany } from '@/actions/auth'
import { adminDb, adminAuth } from '@/lib/firebase-admin'

const UID = 'user-1'
const NEW_COMPANY_ID = 'company-new'

function wire() {
  const batch = { set: vi.fn(), commit: vi.fn().mockResolvedValue(undefined) }

  vi.mocked(adminAuth.verifyIdToken).mockResolvedValue({
    uid: UID,
    email: 'owner@example.com',
  } as never)
  vi.mocked(adminAuth.setCustomUserClaims).mockResolvedValue(undefined as never)

  vi.mocked(adminDb.collection).mockImplementation((path: string) => ({
    path,
    // Idempotency probe: no existing membership, so setup proceeds.
    limit: vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue({ empty: true }),
    }),
    doc: vi.fn().mockReturnValue({ id: NEW_COMPANY_ID, path: `${path}/${NEW_COMPANY_ID}` }),
  } as never))

  vi.mocked(adminDb.doc).mockImplementation((path: string) => ({
    path,
    id: path.split('/').pop(),
  } as never))

  vi.mocked(adminDb.batch).mockReturnValue(batch as never)

  return { batch }
}

describe('setupNewCompany — initial stats map', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes a complete stats map with lastBookingAt present and null', async () => {
    const { batch } = wire()

    await setupNewCompany('id-token', 'Nordfilm AB', 'Owner', 'Europe/Stockholm')

    // The company document is the first thing the batch writes.
    const [, companyDoc] = batch.set.mock.calls[0]
    const payload = companyDoc as Record<string, unknown>
    expect(payload.name).toBe('Nordfilm AB')

    const stats = payload.stats as Record<string, unknown>
    expect(stats.equipmentCount).toBe(0)
    expect(stats.bookingsCreated).toBe(0)
    expect(stats.bookingsCancelled).toBe(0)

    // Present AND null — not merely falsy, and not absent.
    expect('lastBookingAt' in stats).toBe(true)
    expect(stats.lastBookingAt).toBeNull()
  })
})
