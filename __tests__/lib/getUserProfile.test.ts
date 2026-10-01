/**
 * Tests for `getUserProfile` (lib/queries/users.ts) — specifically that the
 * `pendingDeletion` field (issue #252 step 5, PR F) is mapped through and
 * its Firestore Timestamp is converted to the ISO string `UserProfile`
 * documents.
 *
 * `getUserProfile` maps the raw Firestore document field by field, so
 * adding something to the `UserProfile` type alone does not make it reach a
 * caller — same silent-drop trap `docToCompany` had for `stats`
 * (lib/queries/company.ts, __tests__/company/getCompanyDeletion.test.ts is
 * its sibling test). Without this mapping, /no-company (PR F) can never
 * show a stranded member her countdown — the field would silently be
 * `undefined` on every `getUserProfile` call.
 *
 * Firebase Admin is mocked; no network calls are made.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {},
  adminAuth: {},
}))

import { getUserProfile } from '@/lib/queries/users'
import { adminDb } from '@/lib/firebase-admin'

type MockAdminDb = { collection: ReturnType<typeof vi.fn> }

function mockUserDoc(uid: string, data: FirebaseFirestore.DocumentData) {
  const docSnap = {
    exists: true,
    id: uid,
    data: () => data,
  }
  const docRef = { get: vi.fn().mockResolvedValue(docSnap) }
  const collectionRef = { doc: vi.fn().mockReturnValue(docRef) }
  ;(adminDb as unknown as MockAdminDb).collection = vi.fn().mockReturnValue(collectionRef)
}

const BASE_FIELDS = {
  name: 'Anna Andersson',
  email: 'anna@example.com',
  activeCompanyId: '',
}

describe('getUserProfile — pendingDeletion field mapping', () => {
  it('leaves `pendingDeletion` undefined when the field is absent', async () => {
    mockUserDoc('uid-no-schedule', { ...BASE_FIELDS })

    const profile = await getUserProfile('uid-no-schedule')

    expect(profile?.pendingDeletion).toBeUndefined()
  })

  it('maps a plain ISO-string `scheduledFor` through unchanged', async () => {
    mockUserDoc('uid-iso', {
      ...BASE_FIELDS,
      pendingDeletion: {
        scheduledFor: '2026-10-14T10:00:00.000Z',
        requestId: 'req-1',
      },
    })

    const profile = await getUserProfile('uid-iso')

    expect(profile?.pendingDeletion).toEqual({
      scheduledFor: '2026-10-14T10:00:00.000Z',
      requestId: 'req-1',
    })
  })

  // The actual shape memberCleanup.ts (functions/src/company/memberCleanup.ts)
  // writes: a Firestore Timestamp, not an ISO string. This is the mapping
  // this test exists to pin — without `.toDate?.()?.toISOString()`, a real
  // Timestamp object would leak straight into the `UserProfile` the /no-company
  // page renders, breaking `new Date(scheduledFor)` there.
  it('converts a Firestore Timestamp `scheduledFor` to an ISO string', async () => {
    const asTimestamp = (iso: string) => ({ toDate: () => new Date(iso), toISOString: undefined })

    mockUserDoc('uid-timestamp', {
      ...BASE_FIELDS,
      pendingDeletion: {
        scheduledFor: asTimestamp('2026-10-14T10:00:00.000Z'),
        requestId: 'req-2',
      },
    })

    const profile = await getUserProfile('uid-timestamp')

    expect(profile?.pendingDeletion).toEqual({
      scheduledFor: '2026-10-14T10:00:00.000Z',
      requestId: 'req-2',
    })
  })
})

/**
 * Guard against "NaN days left" reaching the /no-company screen. No current
 * writer produces any of these shapes — but nothing structurally prevents
 * one, and an unusable value here flows straight into `new Date(...)` in
 * the UI. Normalising to the empty string is what lets
 * `pendingDeletionCountdown` (lib/pendingDeletionCountdown.ts) report
 * `{ kind: 'unknown' }` and render no countdown at all.
 */
describe('getUserProfile — unusable scheduledFor is normalised, never leaked', () => {
  it.each([
    ['present-but-null', null],
    ['an empty string', ''],
    ['a non-date string', 'soon'],
    ['a number', 1_760_000_000_000],
    ['a raw {seconds,nanoseconds} object with no toDate()', { seconds: 1, nanoseconds: 0 }],
    ['a Timestamp whose toDate() yields an invalid Date', { toDate: () => new Date('nope') }],
  ])('maps %s to an empty string', async (label, value) => {
    mockUserDoc('uid-bad', {
      ...BASE_FIELDS,
      pendingDeletion: { scheduledFor: value, requestId: 'req-bad' },
    })

    const profile = await getUserProfile('uid-bad')

    // Mutation check: without the guard, `value` itself (or `undefined`)
    // comes back here and `new Date(value)` in the UI yields NaN.
    expect(profile?.pendingDeletion).toEqual({ scheduledFor: '', requestId: 'req-bad' })
    expect(typeof profile?.pendingDeletion?.scheduledFor).toBe('string')
  })

  it('keeps the schedule itself — an unusable date must not silently drop pendingDeletion', async () => {
    mockUserDoc('uid-bad-2', {
      ...BASE_FIELDS,
      pendingDeletion: { scheduledFor: '', requestId: 'req-keep' },
    })

    const profile = await getUserProfile('uid-bad-2')

    // She IS scheduled; only the date is unreadable. Dropping the whole
    // field would hide the fact from her entirely, which is worse.
    expect(profile?.pendingDeletion).toBeDefined()
    expect(profile?.pendingDeletion?.requestId).toBe('req-keep')
  })
})
