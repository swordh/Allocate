/**
 * exportUserData (actions/account.ts) — issue #337 step 1, GDPR Art. 15.
 *
 * lolita's review of #337 step 1 required the stuck-deletion trace
 * (`accountDeletionFailures/{uid}`) to be included in the user's own data
 * export: the fact that HER OWN earlier `deleteAccount` attempt(s) failed,
 * where, and how often, is her own data. This file covers only that new
 * `accountDeletionFailure` field — present when a trace doc exists, `null`
 * when it doesn't — not the rest of `exportUserData`'s existing payload
 * (user profile, per-company bookings), which predates this issue.
 *
 * Deliberately no "read failed → null" branch: the trace read lives inside
 * the SAME try block as every other read in this function, so a Firestore
 * error reading it fails the whole export exactly like a failing
 * `userSnap`/`membershipsSnap` read already does elsewhere in this function —
 * there is no separate partial-export policy here to diverge from.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { wireDb, type DocMap, type QueryResolver } from '../helpers/firestore'

const { mockVerifyAuthenticatedSession } = vi.hoisted(() => ({
  mockVerifyAuthenticatedSession: vi.fn(),
}))

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: vi.fn(),
  verifyAuthenticatedSession: mockVerifyAuthenticatedSession,
}))

vi.mock('@/lib/firebase-admin', () => ({
  adminAuth: { deleteUser: vi.fn(), verifySessionCookie: vi.fn() },
  adminDb: {
    doc: vi.fn(),
    collection: vi.fn(),
    collectionGroup: vi.fn(),
    batch: vi.fn(),
    runTransaction: vi.fn(),
  },
}))

import { exportUserData } from '@/actions/account'
import { adminDb } from '@/lib/firebase-admin'

const UID = 'user-1'

const noMemberships: QueryResolver = (ctx) => (ctx.path === `users/${UID}/memberships` ? [] : [])

describe('exportUserData — issue #337 accountDeletionFailure inclusion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthenticatedSession.mockResolvedValue({ uid: UID, email: 'user@example.com' })
  })

  it('includes the trace, with ISO timestamps, when a doc exists for this uid', async () => {
    const docs: DocMap = {
      [`users/${UID}`]: { name: 'Anna', email: 'anna@example.com' },
      [`accountDeletionFailures/${UID}`]: {
        firstAt: { toDate: () => new Date('2026-01-01T00:00:00.000Z') },
        lastAt: { toDate: () => new Date('2026-01-05T00:00:00.000Z') },
        attempts: 3,
        lastPath: 'commit_loop',
        lastErrorCode: 'unavailable',
        lastCompanyIds: ['company-A'],
      },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query: noMemberships })

    const result = await exportUserData()

    expect(result.error).toBeUndefined()
    const payload = JSON.parse(result.json!)
    expect(payload.accountDeletionFailure).toEqual({
      firstAt: '2026-01-01T00:00:00.000Z',
      lastAt: '2026-01-05T00:00:00.000Z',
      attempts: 3,
      lastPath: 'commit_loop',
      lastErrorCode: 'unavailable',
      lastCompanyIds: ['company-A'],
    })
  })

  it('is null when no trace doc exists for this uid', async () => {
    const docs: DocMap = {
      [`users/${UID}`]: { name: 'Anna', email: 'anna@example.com' },
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query: noMemberships })

    const result = await exportUserData()

    expect(result.error).toBeUndefined()
    const payload = JSON.parse(result.json!)
    expect(payload.accountDeletionFailure).toBeNull()
  })
})
