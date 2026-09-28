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
 * Routes both queries `exportUserData`'s `feedbackTickets` build issues:
 *   - `operatorFeedback` filtered by `submittedBy` (must equal `forUid`,
 *     mirroring the production `.where('submittedBy', '==', uid)` call —
 *     tickets belonging to a different uid are never returned even if
 *     present in `tickets`, same as a real Firestore filter would).
 *   - `operatorFeedback/{ticketId}/notes` filtered by `kind` (must equal
 *     'event' — a query without that exact filter gets nothing, so a
 *     regression that widens or drops the filter fails the "no note text"
 *     assertions below instead of silently passing).
 * `users/${forUid}/memberships` (and anything else) resolves to no docs,
 * same as `noMemberships` above — this suite doesn't exercise `companies`.
 */
function feedbackResolver(
  forUid: string,
  tickets: Array<{ id: string; data: Record<string, unknown> }>,
  notesByTicket: Record<string, Array<{ id: string; data: Record<string, unknown> }>>,
): QueryResolver {
  return (ctx) => {
    if (ctx.path === 'operatorFeedback') {
      const f = ctx.filters.find((x) => x.field === 'submittedBy')
      if (!f || f.op !== '==' || f.value !== forUid) return []
      return tickets.map((t) => ({ id: t.id, data: t.data }))
    }
    const notesMatch = ctx.path.match(/^operatorFeedback\/(.+)\/notes$/)
    if (notesMatch) {
      const kindFilter = ctx.filters.find((x) => x.field === 'kind')
      const entries = notesByTicket[notesMatch[1]] ?? []
      if (!kindFilter || kindFilter.op !== '==') return []
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

  it('includes ticket fields + sorted event history, excludes note text', async () => {
    const docs: DocMap = { [`users/${UID}`]: { name: 'Anna', email: 'anna@example.com' } }
    const query = feedbackResolver(
      UID,
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
    // The note's own text must not have leaked in anywhere.
    expect(result.json).not.toContain('VIP')
  })

  it('never includes the operator createdBy email anywhere in the export', async () => {
    const docs: DocMap = { [`users/${UID}`]: { name: 'Anna', email: 'anna@example.com' } }
    const query = feedbackResolver(
      UID,
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
    const query = feedbackResolver(UID, [], {})
    wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })

    const result = await exportUserData()

    expect(result.error).toBeUndefined()
    const payload = JSON.parse(result.json!)
    expect(payload.feedbackTickets).toEqual([])
  })

  it('only exports tickets matching this uid\'s submittedBy filter, not another uid\'s', async () => {
    const docs: DocMap = { [`users/${UID}`]: { name: 'Anna', email: 'anna@example.com' } }
    // feedbackResolver only returns tickets when the captured filter is
    // exactly `submittedBy == UID` — a ticket belonging to 'other-uid' would
    // only leak through if production code dropped or widened that filter.
    const query = feedbackResolver(
      UID,
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
