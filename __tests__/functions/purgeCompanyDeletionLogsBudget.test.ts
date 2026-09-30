/**
 * `purgeCompanyDeletionLogsSweep`'s time budget — `functions/src/company/purgeLogs.ts`
 * (issue #435). Three checkpoints exist: before each rule's turn (a rule
 * that never starts is `skippedRules`, not `unfinishedRows` — its `.get()`
 * never ran, so there is no row count to attribute anything to), before each
 * chunk's `batch.commit()` inside a rule, and inside that rule's
 * per-document fallback. This file exercises the first two; the fallback
 * checkpoint only matters once a chunk has already failed, which is
 * `purgeLogs.ts`'s existing (untouched) failure-handling path and not
 * specific to the budget itself.
 *
 * Fake `Firestore`, same hand-rolled style as `purgeAuditLogsBudget.test.ts`
 * and `purgeOldFeedbackSweepFailures.test.ts`. `runRedactionRule` always
 * issues an optional `equals` `.where()` followed by a `.where(dueField, …)`
 * — the fake query builder records every field name passed to `.where()`
 * and resolves `.get()` off the LAST one, which is always the rule's
 * `dueField` (`purgeAfter` / `completedAt` / `lastHeartbeatAt` — one per
 * rule in `REDACTION_RULES`), so each rule's query can be handed its own
 * canned result without the fake needing to understand Firestore query
 * semantics at all.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { purgeCompanyDeletionLogsSweep, purgeCompanyDeletionLogsUnfinishedCount } from '../../functions/src/company/purgeLogs'

const TOTAL_IDENTITY_DOCS = 500 // BATCH_LIMIT (490) + 10, forcing exactly two chunks.

function makeIdentityDocs(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `companyDeletions/row-${i}`,
    ref: { path: `companyDeletions/row-${i}`, update: vi.fn().mockResolvedValue(undefined) },
    data: () => ({}), // no identity fields set, no marker — eligible, redaction is a no-op write.
  }))
}

/** `resultsByDueField` maps a rule's `dueField` to the docs its query should resolve with. */
function makeFakeDb(
  resultsByDueField: Record<string, ReturnType<typeof makeIdentityDocs>>,
  opts?: { chunkCommitFails?: boolean },
) {
  const commits: number[] = []

  function makeQuery(fields: string[]): FirebaseFirestore.Query {
    return {
      where: vi.fn((field: string) => makeQuery([...fields, field])),
      get: vi.fn(async () => {
        const dueField = fields[fields.length - 1]
        return { docs: resultsByDueField[dueField] ?? [] }
      }),
    } as unknown as FirebaseFirestore.Query
  }

  const db = {
    collection: vi.fn(() => makeQuery([])),
    batch: vi.fn(() => {
      let size = 0
      return {
        update: vi.fn(() => {
          size += 1
        }),
        commit: vi.fn(async () => {
          if (opts?.chunkCommitFails) throw new Error('simulated chunk commit failure')
          commits.push(size)
        }),
      }
    }),
  }
  return { db, commits }
}

describe('purgeCompanyDeletionLogsSweep — time budget (issue #435)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('no deadlineExceeded passed: all three rules run to completion, nothing skipped or unfinished', async () => {
    const { db, commits } = makeFakeDb({ purgeAfter: makeIdentityDocs(3) })

    const result = await purgeCompanyDeletionLogsSweep(
      db as unknown as Parameters<typeof purgeCompanyDeletionLogsSweep>[0],
    )

    expect(result.eligible).toBe(3)
    expect(result.redacted).toBe(3)
    expect(result.failedRows).toBe(0)
    expect(result.unfinishedRows).toBe(0)
    expect(result.skippedRules).toEqual([])
    expect(commits).toEqual([3])
  })

  it('budget trips mid-chunking inside the first rule: the rest of that rule and every later rule are affected, but never double-counted', async () => {
    const { db, commits } = makeFakeDb({ purgeAfter: makeIdentityDocs(TOTAL_IDENTITY_DOCS) })

    // false for the pre-rule check on `identity` and its first chunk; true
    // from its second chunk onward — which also means true for the pre-rule
    // checks on `contacts_completed` and `contacts_failed` that follow.
    let calls = 0
    const deadlineExceeded = () => {
      calls += 1
      return calls > 2
    }

    const result = await purgeCompanyDeletionLogsSweep(
      db as unknown as Parameters<typeof purgeCompanyDeletionLogsSweep>[0],
      undefined,
      { deadlineExceeded },
    )

    // Identity: first chunk (490) committed, second (10) left unfinished.
    expect(result.byRule['identity']).toMatchObject({
      eligible: TOTAL_IDENTITY_DOCS,
      redacted: 490,
      batches: 1,
      failedBatches: 0,
      failedRows: 0,
      unfinishedRows: 10,
    })
    expect(commits).toEqual([490])

    // Both contact rules never got a `.get()` at all — skipped outright, not
    // reflected in `unfinishedRows` (which would double-count them against
    // `skippedRules`).
    expect(result.skippedRules).toEqual(['contacts_completed', 'contacts_failed'])
    expect(result.byRule['contacts_completed']).toBeUndefined()
    expect(result.byRule['contacts_failed']).toBeUndefined()

    // Sweep-level rollups.
    expect(result.eligible).toBe(TOTAL_IDENTITY_DOCS)
    expect(result.redacted).toBe(490)
    expect(result.failedRows).toBe(0)
    expect(result.unfinishedRows).toBe(10)

    // The `onSchedule` wrapper's throw condition (`failedRows > 0 ||
    // unfinishedRows + skippedRules.length > 0`) and the alert's
    // `unfinishedCount` are the SAME expression — issue #435's decision to
    // keep this job's throw behavior consistent with its pre-existing
    // `failedRows > 0` throw. Recomputed here rather than imported, because
    // the wrapper itself (like the other two jobs' wrappers) is exercised at
    // the emulator level, not as a unit — this asserts the inputs that
    // expression consumes are exactly right.
    const unfinishedForAlert = result.unfinishedRows + result.skippedRules.length
    expect(unfinishedForAlert).toBe(12)
    const wouldThrow = result.failedRows > 0 || unfinishedForAlert > 0
    expect(wouldThrow).toBe(true)
  })

  it('budget already exceeded before the sweep starts: every rule is skipped, nothing is queried or written', async () => {
    const { db, commits } = makeFakeDb({ purgeAfter: makeIdentityDocs(5) })

    const result = await purgeCompanyDeletionLogsSweep(
      db as unknown as Parameters<typeof purgeCompanyDeletionLogsSweep>[0],
      undefined,
      { deadlineExceeded: () => true },
    )

    expect(result.skippedRules).toEqual(['identity', 'contacts_completed', 'contacts_failed'])
    expect(result.eligible).toBe(0)
    expect(result.redacted).toBe(0)
    expect(result.unfinishedRows).toBe(0)
    expect(commits).toEqual([])

    const unfinishedForAlert = result.unfinishedRows + result.skippedRules.length
    expect(unfinishedForAlert).toBe(3)
    expect(result.failedRows > 0 || unfinishedForAlert > 0).toBe(true)
  })

  it('budget trips mid per-document fallback: rows already retried stay redacted, the rest are unfinished, not failed', async () => {
    // A small chunk (5 rows, well under BATCH_LIMIT) whose single
    // `batch.commit()` fails outright, forcing layer 2's per-document
    // fallback (see `runRedactionRule`'s docblock). Each row's own
    // `ref.update()` succeeds — this test is about the BUDGET cutting the
    // fallback short, not about any row itself being unwritable.
    const docs = makeIdentityDocs(5)
    const { db, commits } = makeFakeDb({ purgeAfter: docs }, { chunkCommitFails: true })

    let calls = 0
    // Call order: 1) before the `identity` rule starts, 2) before its one
    // (failing) chunk commit, 3)-4) the fallback's first two per-document
    // retries, 5) onward — the budget trips, cutting the fallback short
    // after exactly 2 of the 5 rows were retried.
    const deadlineExceeded = () => {
      calls += 1
      return calls > 4
    }

    const result = await purgeCompanyDeletionLogsSweep(
      db as unknown as Parameters<typeof purgeCompanyDeletionLogsSweep>[0],
      undefined,
      { deadlineExceeded },
    )

    expect(commits).toEqual([]) // the chunk commit itself always failed.
    expect(result.byRule['identity']).toMatchObject({
      eligible: 5,
      redacted: 2, // the two rows retried before the budget tripped.
      batches: 0,
      failedBatches: 1,
      failedRows: 0,
      unfinishedRows: 3, // never retried once the budget ran out.
    })
    // The rows the fallback actually reached did get their per-document
    // `update()` called.
    expect(docs[0].ref.update).toHaveBeenCalledTimes(1)
    expect(docs[1].ref.update).toHaveBeenCalledTimes(1)
    expect(docs[2].ref.update).not.toHaveBeenCalled()
    expect(docs[3].ref.update).not.toHaveBeenCalled()
    expect(docs[4].ref.update).not.toHaveBeenCalled()
  })
})

describe('purgeCompanyDeletionLogsUnfinishedCount', () => {
  it('folds unfinishedRows and skippedRules.length into a single number — the same expression the onSchedule wrapper used to write out twice', () => {
    expect(purgeCompanyDeletionLogsUnfinishedCount({ unfinishedRows: 0, skippedRules: [] })).toBe(0)
    expect(purgeCompanyDeletionLogsUnfinishedCount({ unfinishedRows: 10, skippedRules: [] })).toBe(10)
    expect(purgeCompanyDeletionLogsUnfinishedCount({ unfinishedRows: 0, skippedRules: ['contacts_completed'] })).toBe(1)
    expect(
      purgeCompanyDeletionLogsUnfinishedCount({ unfinishedRows: 10, skippedRules: ['contacts_completed', 'contacts_failed'] }),
    ).toBe(12)
  })
})
