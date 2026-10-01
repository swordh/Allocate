/**
 * `mapDeletionDoc` (lib/operatorDeletionQueries.ts) — specifically the
 * `operatorActions` mapping, exercised through `queryDeletionsByCompany`
 * (the private mapper isn't exported).
 *
 * This is the regression test for the fix that replaced `?? null` with a
 * plain pass-through on `byUid`/`byName`: since `actions/operatorCompanyDeletion.ts`
 * (issue #252 step 6, PR 5) became a real second writer of `operatorActions`
 * entries, `?? null` would silently render an entry with a genuinely OMITTED
 * field as "redacted by the 24-month retention job" instead of surfacing the
 * bug. See identityDisplay in lib/operatorDeletionView.ts for what each of
 * the three states is supposed to mean.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: { collection: vi.fn() },
}))

import { adminDb } from '@/lib/firebase-admin'
import { LIST_VIEW_LIMIT, queryDeletionsByCompany, queryStuckAccountDeletions } from '@/lib/operatorDeletionQueries'
import { identityDisplay } from '@/lib/operatorDeletionView'

function wireCompanyDeletions(docs: Array<Record<string, unknown>>) {
  const chain = {
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    get: async () => ({
      docs: docs.map((data, i) => ({ id: `req-${i}`, data: () => data })),
    }),
  }
  vi.mocked(adminDb.collection).mockReturnValue(chain as unknown as ReturnType<typeof adminDb.collection>)
}

const BASE = {
  requestId: 'req-0',
  companyId: 'company-A',
  companyName: 'Rigg & Rep AB',
  mode: 'window',
  state: 'canceled',
  requestedAt: '2026-01-01T00:00:00.000Z',
  requestedByUid: 'uid-1',
  requestedByName: 'Anna Admin',
  requestedByEmail: 'anna@example.com',
  scheduledFor: '2026-01-08T00:00:00.000Z',
  attempts: 0,
}

describe('mapDeletionDoc — operatorActions byUid/byName', () => {
  it('passes an explicit string through unchanged — renders as "known"', async () => {
    wireCompanyDeletions([
      { ...BASE, operatorActions: [{ action: 'cancel', byUid: 'op-1', byName: 'jocke@allocate.at', at: '2026-01-02T00:00:00.000Z' }] },
    ])
    const [row] = await queryDeletionsByCompany('company-A')
    const entry = row.operatorActions![0]
    expect(entry.byUid).toBe('op-1')
    expect(entry.byName).toBe('jocke@allocate.at')
    expect(identityDisplay(entry.byName)).toEqual({ kind: 'known', text: 'jocke@allocate.at' })
  })

  it('passes an explicit null through unchanged — renders as "redacted"', async () => {
    wireCompanyDeletions([
      { ...BASE, operatorActions: [{ action: 'cancel', byUid: null, byName: null, at: '2026-01-02T00:00:00.000Z' }] },
    ])
    const [row] = await queryDeletionsByCompany('company-A')
    const entry = row.operatorActions![0]
    expect(entry.byUid).toBeNull()
    expect(entry.byName).toBeNull()
    expect(identityDisplay(entry.byName)).toEqual({ kind: 'redacted' })
  })

  it('MUTATION GUARD: an OMITTED field passes through as undefined, NOT null — this is the whole point of the fix', async () => {
    // A malformed/legacy entry that never carried an actor at all — the
    // field is genuinely absent from the object, not set to null.
    wireCompanyDeletions([
      { ...BASE, operatorActions: [{ action: 'cancel', at: '2026-01-02T00:00:00.000Z' }] },
    ])
    const [row] = await queryDeletionsByCompany('company-A')
    const entry = row.operatorActions![0]
    expect(entry.byUid).toBeUndefined()
    expect(entry.byName).toBeUndefined()
    // The regression this guards against: `?? null` would have made this
    // read back as 'redacted' — a lie about a 24-month-old retention pass
    // that never touched this brand-new row.
    expect(identityDisplay(entry.byName)).toEqual({ kind: 'never' })
  })
})

describe('mapDeletionDoc — issue #331/#335 failure + no-progress fields', () => {
  it('maps failureReason, failedAt, failedNotifiedAt, failedNotifiedCount, noProgressResumes, progressUnits', async () => {
    wireCompanyDeletions([
      {
        ...BASE,
        state: 'failed',
        failureReason: 'no_progress',
        failedAt: '2026-02-01T00:00:00.000Z',
        failedNotifiedAt: '2026-02-01T00:05:00.000Z',
        failedNotifiedCount: 2,
        noProgressResumes: 3,
        progressUnits: 41,
      },
    ])
    const [row] = await queryDeletionsByCompany('company-A')
    expect(row.failureReason).toBe('no_progress')
    expect(row.failedAt).toBe('2026-02-01T00:00:00.000Z')
    expect(row.failedNotifiedAt).toBe('2026-02-01T00:05:00.000Z')
    expect(row.failedNotifiedCount).toBe(2)
    expect(row.noProgressResumes).toBe(3)
    expect(row.progressUnits).toBe(41)
  })

  it('leaves them undefined on a row that never failed', async () => {
    wireCompanyDeletions([{ ...BASE }])
    const [row] = await queryDeletionsByCompany('company-A')
    expect(row.failureReason).toBeUndefined()
    expect(row.failedAt).toBeUndefined()
    expect(row.failedNotifiedAt).toBeUndefined()
    expect(row.failedNotifiedCount).toBeUndefined()
    expect(row.noProgressResumes).toBeUndefined()
    expect(row.progressUnits).toBeUndefined()
  })
})

// ── queryStuckAccountDeletions (issue #337 step 1) ──────────────────────────

function wireAccountDeletionFailures(docs: Array<{ id: string; data: Record<string, unknown> }>) {
  const chain: Record<string, unknown> = {
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    get: async () => ({
      docs: docs.map(({ id, data }) => ({ id, data: () => data })),
    }),
  }
  vi.mocked(adminDb.collection).mockReturnValue(chain as unknown as ReturnType<typeof adminDb.collection>)
  return chain as { orderBy: ReturnType<typeof vi.fn>; limit: ReturnType<typeof vi.fn> }
}

describe('queryStuckAccountDeletions', () => {
  it('maps a well-formed doc to a StuckAccountDeletionRow, keyed by doc id (uid)', async () => {
    wireAccountDeletionFailures([
      {
        id: 'user-42',
        data: {
          firstAt: { toDate: () => new Date('2026-01-01T00:00:00.000Z') },
          lastAt: { toDate: () => new Date('2026-01-05T00:00:00.000Z') },
          attempts: 4,
          lastPath: 'commit_loop',
          lastErrorCode: 'unavailable',
          lastCompanyIds: ['company-A', 'company-B'],
        },
      },
    ])

    const [row] = await queryStuckAccountDeletions()

    expect(row).toEqual({
      uid: 'user-42',
      firstAt: '2026-01-01T00:00:00.000Z',
      lastAt: '2026-01-05T00:00:00.000Z',
      attempts: 4,
      lastPath: 'commit_loop',
      lastErrorCode: 'unavailable',
      lastCompanyIds: ['company-A', 'company-B'],
    })
  })

  it('queries orderBy(lastAt, desc) with limit(LIST_VIEW_LIMIT), and preserves that order when mapping', async () => {
    const chain = wireAccountDeletionFailures([
      { id: 'user-1', data: { attempts: 1, lastCompanyIds: [] } },
      { id: 'user-2', data: { attempts: 2, lastCompanyIds: [] } },
    ])

    const rows = await queryStuckAccountDeletions()

    // Sorting by the wrong field, or dropping the limit, must fail this test
    // — the previous version of this test only checked the mapper's own
    // order-preservation and would have passed even if the query itself
    // sorted on the wrong field or asked for no limit at all.
    expect(chain.orderBy).toHaveBeenCalledWith('lastAt', 'desc')
    expect(chain.limit).toHaveBeenCalledWith(LIST_VIEW_LIMIT)
    expect(rows.map((r) => r.uid)).toEqual(['user-1', 'user-2'])
  })

  it('defaults a missing attempts/lastErrorCode/lastCompanyIds defensively rather than throwing', async () => {
    wireAccountDeletionFailures([{ id: 'user-1', data: {} }])

    const [row] = await queryStuckAccountDeletions()

    expect(row.attempts).toBe(0)
    expect(row.lastErrorCode).toBeNull()
    expect(row.lastCompanyIds).toEqual([])
    expect(row.firstAt).toBe('')
    expect(row.lastAt).toBe('')
  })
})
