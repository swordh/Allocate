/**
 * exportUserData (actions/account.ts) — issue #337 step 1, GDPR Art. 15;
 * issue #415, GDPR Art. 15/20.
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
 *
 * Issue #415 added `feedbackTickets`: the user's own `operatorFeedback`
 * support tickets, plus each ticket's `kind: 'event'` status/priority-change
 * history — deliberately excluding `kind: 'note'` (operator free-text, not
 * this user's own data) and `createdBy` (the operator's email, third-party
 * PII) everywhere. See the block comment in `actions/account.ts` above the
 * `feedbackTickets` build for the full reasoning.
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

// ── issue #415: feedbackTickets ────────────────────────────────────────────

const OPERATOR_EMAIL = 'ops@allocate.at'

/**
 * Routes both queries `exportUserData`'s `feedbackTickets` build issues,
 * modelling real Firestore behaviour rather than "no exact filter → nothing":
 *   - `operatorFeedback` — WITH a `submittedBy` filter, returns only the
 *     tickets whose own `data.submittedBy` matches its value (a real
 *     `.where('submittedBy', '==', uid)` query does exactly this). WITH NO
 *     `submittedBy` filter at all, returns EVERY ticket in the fixture —
 *     same as an unfiltered collection read would. That asymmetry is the
 *     point: if production code ever drops the `.where(...)` call, this
 *     resolver hands back every ticket regardless of owner, so a ticket
 *     belonging to another uid leaks into the export and the assertions
 *     below catch it — a resolver that instead answered "[]" for a missing
 *     filter would make that regression silently pass.
 *   - `operatorFeedback/{ticketId}/notes` — same shape: WITH a `kind` filter,
 *     returns only entries whose own `data.kind` matches its value; WITH NO
 *     `kind` filter, returns every entry for that ticket, notes included. So
 *     dropping the production `.where('kind', '==', 'event')` call leaks
 *     note text into `statusHistory`, which the "no note text" assertions
 *     below then catch.
 * `users/${uid}/memberships` (and anything else) resolves to no docs, same
 * as `noMemberships` above — this suite doesn't exercise `companies`.
 */
function feedbackResolver(
  tickets: Array<{ id: string; data: Record<string, unknown> }>,
  notesByTicket: Record<string, Array<{ id: string; data: Record<string, unknown> }>>,
): QueryResolver {
  return (ctx) => {
    if (ctx.path === 'operatorFeedback') {
      const f = ctx.filters.find((x) => x.field === 'submittedBy')
      if (!f) return tickets.map((t) => ({ id: t.id, data: t.data }))
      return tickets.filter((t) => t.data.submittedBy === f.value).map((t) => ({ id: t.id, data: t.data }))
    }
    const notesMatch = ctx.path.match(/^operatorFeedback\/(.+)\/notes$/)
    if (notesMatch) {
      const entries = notesByTicket[notesMatch[1]] ?? []
      const kindFilter = ctx.filters.find((x) => x.field === 'kind')
      if (!kindFilter) return entries
      return entries.filter((e) => e.data.kind === kindFilter.value)
    }
    return []
  }
}

describe('exportUserData — issue #415 feedbackTickets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthenticatedSession.mockResolvedValue({ uid: UID, email: 'user@example.com' })
  })

  it('includes ticket fields + sorted event history, excludes note text (incl. legacy no-kind notes)', async () => {
    const docs: DocMap = { [`users/${UID}`]: { name: 'Anna', email: 'anna@example.com' } }
    const query = feedbackResolver(
      [
        {
          id: 'BUG-1111',
          data: {
            type: 'bug_report',
            title: 'Broken calendar',
            description: 'Nothing loads',
            submittedAt: { toDate: () => new Date('2026-01-01T00:00:00.000Z') },
            submittedBy: UID,
            companyId: 'company-A',
            companyName: 'Acme AB',
            userName: 'Anna',
            status: 'in_progress',
            priority: 'high',
          },
        },
      ],
      {
        'BUG-1111': [
          {
            id: 'ev-2',
            data: {
              kind: 'event',
              text: 'Priority changed Medium → High',
              createdAt: { toDate: () => new Date('2026-01-03T00:00:00.000Z') },
              createdBy: OPERATOR_EMAIL,
            },
          },
          {
            id: 'ev-1',
            data: {
              kind: 'event',
              text: 'Status changed Open → In progress',
              createdAt: { toDate: () => new Date('2026-01-02T00:00:00.000Z') },
              createdBy: OPERATOR_EMAIL,
            },
          },
          {
            id: 'note-1',
            data: {
              kind: 'note',
              text: 'Customer is a VIP, escalate quietly',
              createdAt: { toDate: () => new Date('2026-01-02T12:00:00.000Z') },
              createdBy: OPERATOR_EMAIL,
            },
          },
          // Legacy doc predating the `kind` field entirely (types/operator.ts:
          // must be read as a note, never included) — no `kind` key at all,
          // not even an empty/falsy one.
          {
            id: 'legacy-1',
            data: {
              text: 'legacy note',
              createdAt: { toDate: () => new Date('2026-01-02T18:00:00.000Z') },
              createdBy: OPERATOR_EMAIL,
            },
          },
        ],
      },
    )
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })

    const result = await exportUserData()

    expect(result.error).toBeUndefined()
    const payload = JSON.parse(result.json!)
    expect(payload.feedbackTickets).toEqual([
      {
        ticketId: 'BUG-1111',
        type: 'bug_report',
        title: 'Broken calendar',
        description: 'Nothing loads',
        status: 'in_progress',
        priority: 'high',
        companyName: 'Acme AB',
        submittedAt: '2026-01-01T00:00:00.000Z',
        statusHistory: [
          { text: 'Status changed Open → In progress', at: '2026-01-02T00:00:00.000Z' },
          { text: 'Priority changed Medium → High', at: '2026-01-03T00:00:00.000Z' },
        ],
      },
    ])
    // Neither the `kind: 'note'` entry's nor the legacy (no-`kind`) entry's
    // own text must have leaked in anywhere.
    expect(result.json).not.toContain('VIP')
    expect(result.json).not.toContain('legacy note')
  })

  it('sorts an event with no createdAt (`at: null`) LAST, not first', async () => {
    const docs: DocMap = { [`users/${UID}`]: { name: 'Anna', email: 'anna@example.com' } }
    const query = feedbackResolver(
      [
        {
          id: 'BUG-2222',
          data: {
            type: 'bug_report',
            title: 'Undated event ticket',
            description: 'd',
            submittedAt: { toDate: () => new Date('2026-01-01T00:00:00.000Z') },
            submittedBy: UID,
            companyId: 'company-A',
            companyName: 'Acme AB',
            userName: 'Anna',
            status: 'open',
            priority: 'low',
          },
        },
      ],
      {
        'BUG-2222': [
          {
            id: 'ev-undated',
            data: { kind: 'event', text: 'Undated event', createdBy: OPERATOR_EMAIL },
          },
          {
            id: 'ev-dated',
            data: {
              kind: 'event',
              text: 'Dated event',
              createdAt: { toDate: () => new Date('2026-01-02T00:00:00.000Z') },
              createdBy: OPERATOR_EMAIL,
            },
          },
        ],
      },
    )
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })

    const result = await exportUserData()

    expect(result.error).toBeUndefined()
    const payload = JSON.parse(result.json!)
    expect(payload.feedbackTickets[0].statusHistory).toEqual([
      { text: 'Dated event', at: '2026-01-02T00:00:00.000Z' },
      { text: 'Undated event', at: null },
    ])
  })

  it('never includes the operator createdBy email anywhere in the export', async () => {
    const docs: DocMap = { [`users/${UID}`]: { name: 'Anna', email: 'anna@example.com' } }
    const query = feedbackResolver(
      [
        {
          id: 'BUG-1111',
          data: {
            type: 'bug_report',
            title: 'Broken calendar',
            description: 'Nothing loads',
            submittedAt: { toDate: () => new Date('2026-01-01T00:00:00.000Z') },
            submittedBy: UID,
            companyId: 'company-A',
            companyName: 'Acme AB',
            userName: 'Anna',
            status: 'open',
            priority: 'medium',
          },
        },
      ],
      {
        'BUG-1111': [
          {
            id: 'ev-1',
            data: {
              kind: 'event',
              text: 'Status changed Open → In progress',
              createdAt: { toDate: () => new Date('2026-01-02T00:00:00.000Z') },
              createdBy: OPERATOR_EMAIL,
            },
          },
        ],
      },
    )
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })

    const result = await exportUserData()

    expect(result.error).toBeUndefined()
    expect(result.json).not.toContain(OPERATOR_EMAIL)
  })

  it('is an empty array when the user has no tickets', async () => {
    const docs: DocMap = { [`users/${UID}`]: { name: 'Anna', email: 'anna@example.com' } }
    const query = feedbackResolver([], {})
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })

    const result = await exportUserData()

    expect(result.error).toBeUndefined()
    const payload = JSON.parse(result.json!)
    expect(payload.feedbackTickets).toEqual([])
  })

  it('only exports tickets matching this uid\'s submittedBy filter, not another uid\'s', async () => {
    const docs: DocMap = { [`users/${UID}`]: { name: 'Anna', email: 'anna@example.com' } }
    // The fixture genuinely contains a second ticket for 'other-uid' —
    // `feedbackResolver` (unlike before this revision) does NOT pre-filter
    // by the uid the test expects; it filters strictly by whatever
    // `submittedBy` value the captured `.where()` call carries, same as real
    // Firestore. So this assertion is only meaningful because the production
    // `.where('submittedBy', '==', uid)` call is what keeps 'other-uid-ticket'
    // out — a dropped/widened filter would leak it straight into the payload.
    const query = feedbackResolver(
      [
        {
          id: 'BUG-1111',
          data: {
            type: 'bug_report',
            title: 'Mine',
            description: 'd',
            submittedAt: { toDate: () => new Date('2026-01-01T00:00:00.000Z') },
            submittedBy: UID,
            companyId: 'company-A',
            companyName: 'Acme AB',
            userName: 'Anna',
            status: 'open',
            priority: 'low',
          },
        },
        {
          id: 'other-uid-ticket',
          data: {
            type: 'bug_report',
            title: 'Not mine',
            description: 'd',
            submittedAt: { toDate: () => new Date('2026-01-01T00:00:00.000Z') },
            submittedBy: 'other-uid',
            companyId: 'company-A',
            companyName: 'Acme AB',
            userName: 'Someone Else',
            status: 'open',
            priority: 'low',
          },
        },
      ],
      {},
    )
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })

    const result = await exportUserData()

    const payload = JSON.parse(result.json!)
    expect(payload.feedbackTickets).toHaveLength(1)
    expect(payload.feedbackTickets[0].ticketId).toBe('BUG-1111')
    expect(payload.feedbackTickets.some((t: { ticketId: string }) => t.ticketId === 'other-uid-ticket')).toBe(false)
  })

  it('fails the whole export when the ticket query throws', async () => {
    const docs: DocMap = { [`users/${UID}`]: { name: 'Anna', email: 'anna@example.com' } }
    const query: QueryResolver = (ctx) => {
      if (ctx.path === 'operatorFeedback') throw new Error('Firestore unavailable')
      return []
    }
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })

    const result = await exportUserData()

    expect(result).toEqual({ error: 'Failed to export data' })
  })
})
