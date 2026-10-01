/**
 * Tests for `docToCompany` (via `getCompany`) — specifically that the
 * `deletion` field (issue #252, step 5) is mapped through.
 *
 * `docToCompany` maps the raw Firestore document field by field, so adding
 * something to the `Company` type alone does not make it reach a caller —
 * see the comment above the `deletion` mapping in lib/queries/company.ts.
 * `stats` already went missing this way; this test exists so `deletion`
 * doesn't join it, and so a future refactor of `docToCompany` gets a signal
 * if it silently drops the field again.
 *
 * Firebase Admin is mocked; no network calls are made.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {},
  adminAuth: {},
}))

import { getCompany } from '@/lib/queries/company'
import { adminDb } from '@/lib/firebase-admin'

type MockAdminDb = { collection: ReturnType<typeof vi.fn> }

function mockCompanyDoc(companyId: string, data: FirebaseFirestore.DocumentData) {
  const docSnap = {
    exists: true,
    id: companyId,
    data: () => data,
  }
  const docRef = { get: vi.fn().mockResolvedValue(docSnap) }
  const collectionRef = { doc: vi.fn().mockReturnValue(docRef) }
  ;(adminDb as unknown as MockAdminDb).collection = vi.fn().mockReturnValue(collectionRef)
}

const BASE_FIELDS = {
  name: 'Rigg & Rep AB',
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'uid-owner',
  stripeCustomerId: 'cus_123',
  subscription: {
    status: 'active',
    plan: 'starter',
    currentPeriodEnd: '2026-02-01T00:00:00.000Z',
    limits: { equipment: 25, users: 10 },
  },
}

describe('docToCompany — deletion field mapping', () => {
  it('maps `deletion` when the field is present on the document', async () => {
    mockCompanyDoc('company-with-deletion', {
      ...BASE_FIELDS,
      deletion: {
        state: 'requested',
        requestId: 'req-1',
        requestedAt: '2026-09-13T10:00:00.000Z',
        requestedByName: 'Anna Admin',
        scheduledFor: '2026-09-20T10:00:00.000Z',
        mode: 'window',
      },
    })

    const company = await getCompany('company-with-deletion')

    expect(company?.deletion).toEqual({
      state: 'requested',
      requestId: 'req-1',
      requestedAt: '2026-09-13T10:00:00.000Z',
      requestedByName: 'Anna Admin',
      scheduledFor: '2026-09-20T10:00:00.000Z',
      mode: 'window',
      remindedAt: undefined,
      claimedAt: undefined,
    })
  })

  it('converts Firestore Timestamp-like fields on `deletion` to ISO strings', async () => {
    const asTimestamp = (iso: string) => ({ toDate: () => new Date(iso), toISOString: undefined })

    mockCompanyDoc('company-with-timestamp-deletion', {
      ...BASE_FIELDS,
      deletion: {
        state: 'executing',
        requestId: 'req-2',
        requestedAt: asTimestamp('2026-09-01T00:00:00.000Z'),
        requestedByName: 'Björn Boss',
        scheduledFor: asTimestamp('2026-09-08T00:00:00.000Z'),
        mode: 'window',
        remindedAt: asTimestamp('2026-09-06T00:00:00.000Z'),
        claimedAt: asTimestamp('2026-09-08T00:05:00.000Z'),
      },
    })

    const company = await getCompany('company-with-timestamp-deletion')

    expect(company?.deletion).toEqual({
      state: 'executing',
      requestId: 'req-2',
      requestedAt: '2026-09-01T00:00:00.000Z',
      requestedByName: 'Björn Boss',
      scheduledFor: '2026-09-08T00:00:00.000Z',
      mode: 'window',
      remindedAt: '2026-09-06T00:00:00.000Z',
      claimedAt: '2026-09-08T00:05:00.000Z',
    })
  })

  it('leaves `deletion` as undefined when the field is absent', async () => {
    mockCompanyDoc('company-without-deletion', { ...BASE_FIELDS })

    const company = await getCompany('company-without-deletion')

    expect(company?.deletion).toBeUndefined()
  })
})
