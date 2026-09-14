/**
 * Tests for docToCompany / getCompany — lib/queries/company.ts.
 *
 * `docToCompany` maps the Firestore document field by field, so a field that
 * exists only on the Firestore document and in the `Company` type — but not
 * in this mapping function — reaches every writer and no reader. That is a
 * proven bug shape here: `stats` was written by lib/companyStats.ts on every
 * booking/equipment mutation and was silently dropped by this function until
 * now. This file locks down that `stats` and the Stripe pause-collection
 * mirror (`pauseCollection` / `pauseResumesAt`, added to the webhook in the
 * same change) both survive the trip through `getCompany`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {
    collection: vi.fn(),
  },
  adminAuth: {},
}))

import { adminDb } from '@/lib/firebase-admin'
import { getCompany } from '@/lib/queries/company'

type Data = Record<string, unknown>

function wireCompanyDoc(companyId: string, data: Data | null) {
  vi.mocked(adminDb.collection).mockReturnValue({
    doc: () => ({
      get: async () => ({
        exists: data !== null,
        id: companyId,
        data: () => data ?? undefined,
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, not the real Firestore type
  } as any)
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── stats mapping ─────────────────────────────────────────────────────────────

describe('getCompany — stats mapping', () => {
  it('returns stats when the document carries a stats mirror', async () => {
    const updatedAt = { toDate: () => new Date('2026-08-01T00:00:00.000Z') }
    const lastBookingAt = { toDate: () => new Date('2026-07-15T00:00:00.000Z') }

    wireCompanyDoc('co-stats-1', {
      name: 'Nordfilm AB',
      stripeCustomerId: 'cus_1',
      subscription: { status: 'active', plan: 'basic' },
      stats: {
        equipmentCount: 12,
        bookingsCreated: 40,
        bookingsCancelled: 3,
        lastBookingAt,
        memberCount: 5,
        updatedAt,
      },
    })

    const company = await getCompany('co-stats-1')

    expect(company?.stats).toEqual({
      equipmentCount: 12,
      bookingsCreated: 40,
      bookingsCancelled: 3,
      lastBookingAt: '2026-07-15T00:00:00.000Z',
      memberCount: 5,
      updatedAt: '2026-08-01T00:00:00.000Z',
    })
  })

  it('omits stats entirely on a pre-migration company document that never had the mirror', async () => {
    wireCompanyDoc('co-stats-2', {
      name: 'Legacy AB',
      stripeCustomerId: 'cus_2',
      subscription: { status: 'active', plan: 'basic' },
      // no `stats` field at all
    })

    const company = await getCompany('co-stats-2')

    expect(company?.stats).toBeUndefined()
  })

  it('defaults lastBookingAt to null and updatedAt to empty string when the stats object is missing those subfields', async () => {
    wireCompanyDoc('co-stats-3', {
      name: 'Partial AB',
      stripeCustomerId: 'cus_3',
      subscription: { status: 'active', plan: 'basic' },
      stats: { equipmentCount: 0, bookingsCreated: 0, bookingsCancelled: 0, memberCount: 1 },
    })

    const company = await getCompany('co-stats-3')

    expect(company?.stats?.lastBookingAt).toBeNull()
    expect(company?.stats?.updatedAt).toBe('')
  })
})

// ── pause_collection mirror mapping ──────────────────────────────────────────

describe('getCompany — pauseCollection / pauseResumesAt mapping', () => {
  it('maps both fields through from the Firestore mirror', async () => {
    wireCompanyDoc('co-pause-1', {
      name: 'Paused AB',
      stripeCustomerId: 'cus_4',
      subscription: {
        status: 'active',
        plan: 'basic',
        pauseCollection: 'void',
        pauseResumesAt: '2026-09-20T00:00:00.000Z',
      },
    })

    const company = await getCompany('co-pause-1')

    expect(company?.subscription.pauseCollection).toBe('void')
    expect(company?.subscription.pauseResumesAt).toBe('2026-09-20T00:00:00.000Z')
  })

  it('defaults both fields to null when the subscription has never been paused', async () => {
    wireCompanyDoc('co-pause-2', {
      name: 'Never Paused AB',
      stripeCustomerId: 'cus_5',
      subscription: { status: 'active', plan: 'basic' },
    })

    const company = await getCompany('co-pause-2')

    expect(company?.subscription.pauseCollection).toBeNull()
    expect(company?.subscription.pauseResumesAt).toBeNull()
  })
})
