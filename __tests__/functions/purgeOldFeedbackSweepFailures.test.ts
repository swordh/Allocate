/**
 * `purgeOldFeedbackSweep` — `functions/src/admin/purgeOldFeedback.ts`
 * (issue #433). The reopen-race guard added a `doc.ref.get()` re-read
 * immediately before each ticket's `recursiveDelete` (see
 * `__tests__/functions/purgeOldFeedbackReopenGuard.test.ts` for the pure
 * eligibility check that re-read feeds). That re-read originally sat
 * OUTSIDE the per-ticket try/catch: a single rejected re-read (a transient
 * Firestore error, not even a "the ticket is gone" case) threw out of the
 * whole `for` loop, abandoning every remaining ticket in the sweep and
 * skipping `bulkWriter.close()` entirely — the fix moves the re-read inside
 * the per-ticket try/catch, counts it as a `failed` ticket, and moves
 * `close()` into a `finally` so it always runs.
 *
 * This is a unit test against a hand-rolled fake `Firestore`, not an
 * emulator test, because the emulator gives no way to make a single,
 * specific `doc.ref.get()` call reject on demand — every other read in the
 * same sweep needs to keep succeeding around it, and the real Firestore
 * client has no test-only seam for injecting a one-shot failure into an
 * otherwise-healthy connection. Forcing that from the emulator would need a
 * production-code seam that doesn't otherwise need to exist. A fake `db`
 * that resolves/rejects exactly as each case dictates is what actually
 * lets this race be exercised deterministically.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { logger } from 'firebase-functions/v2'
import { purgeOldFeedbackSweep, purgeOldFeedbackFailedCount } from '../../functions/src/admin/purgeOldFeedback'
import { runWithRetentionAlert, RETENTION_PURGE_FAILED_LOG_MARKER } from '../../functions/src/admin/retentionPurgeAlert'

// 25 months ago — safely older than the sweep's 24-month cutoff.
const CLOSED_AT_MILLIS = Date.now() - 25 * 30 * 24 * 60 * 60 * 1000

function closedTimestamp() {
  return { toMillis: () => CLOSED_AT_MILLIS }
}

interface FakeDoc {
  ref: {
    path: string
    get: () => Promise<{ exists: boolean; data: () => Record<string, unknown> }>
  }
}

function makeTicketDoc(path: string, opts?: { rereadRejectsWith?: Error; reopened?: boolean }): FakeDoc {
  return {
    ref: {
      path,
      get: () => {
        if (opts?.rereadRejectsWith) return Promise.reject(opts.rereadRejectsWith)
        if (opts?.reopened) return Promise.resolve({ exists: true, data: () => ({}) })
        return Promise.resolve({ exists: true, data: () => ({ closedAt: closedTimestamp() }) })
      },
    },
  }
}

function makeFakeDb(
  docs: FakeDoc[],
  overrides?: {
    recursiveDelete?: ReturnType<typeof vi.fn>
    close?: ReturnType<typeof vi.fn>
  },
) {
  const bulkWriter = {
    onWriteError: vi.fn(),
    close: overrides?.close ?? vi.fn().mockResolvedValue(undefined),
  }
  const recursiveDelete = overrides?.recursiveDelete ?? vi.fn().mockResolvedValue(undefined)
  const db = {
    collection: vi.fn(() => ({
      where: vi.fn(() => ({
        get: vi.fn().mockResolvedValue({ empty: docs.length === 0, docs }),
      })),
    })),
    bulkWriter: vi.fn(() => bulkWriter),
    recursiveDelete,
  }
  return { db, bulkWriter, recursiveDelete }
}

describe('purgeOldFeedbackSweep — re-read failure handling (issue #433)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('case 1: a rejected re-read for one ticket does not abort the sweep', async () => {
    const errorSpy = vi.spyOn(logger, 'error')
    const rereadError = new Error('14 UNAVAILABLE: transient')
    const docs = [
      makeTicketDoc('operatorFeedback/ticket-1'),
      makeTicketDoc('operatorFeedback/ticket-2', { rereadRejectsWith: rereadError }),
      makeTicketDoc('operatorFeedback/ticket-3'),
    ]
    const { db, recursiveDelete, bulkWriter } = makeFakeDb(docs)

    await expect(purgeOldFeedbackSweep(db as unknown as Parameters<typeof purgeOldFeedbackSweep>[0])).resolves.toEqual({
      purged: 2,
      failed: 1,
      closeFailed: false,
    })

    expect(recursiveDelete).toHaveBeenCalledTimes(2)
    const deletedPaths = recursiveDelete.mock.calls.map((call) => (call[0] as { path: string }).path)
    expect(deletedPaths).toEqual(['operatorFeedback/ticket-1', 'operatorFeedback/ticket-3'])
    expect(bulkWriter.close).toHaveBeenCalledTimes(1)

    const matchingCalls = errorSpy.mock.calls.filter(
      (call) => call[1] && (call[1] as Record<string, unknown>).path === 'operatorFeedback/ticket-2',
    )
    expect(matchingCalls).toHaveLength(1)
    const [, meta] = matchingCalls[0]
    expect(meta).toEqual({ path: 'operatorFeedback/ticket-2', error: '14 UNAVAILABLE: transient' })
    expect(Object.keys(meta as object).sort()).toEqual(['error', 'path'])
  })

  it('case 2: re-read succeeds but recursiveDelete rejects for one ticket', async () => {
    const docs = [
      makeTicketDoc('operatorFeedback/ticket-1'),
      makeTicketDoc('operatorFeedback/ticket-2'),
      makeTicketDoc('operatorFeedback/ticket-3'),
    ]
    const recursiveDelete = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('permanent delete failure'))
      .mockResolvedValueOnce(undefined)
    const { db, bulkWriter } = makeFakeDb(docs, { recursiveDelete })

    await expect(purgeOldFeedbackSweep(db as unknown as Parameters<typeof purgeOldFeedbackSweep>[0])).resolves.toEqual({
      purged: 2,
      failed: 1,
      closeFailed: false,
    })
    expect(recursiveDelete).toHaveBeenCalledTimes(3)
    expect(bulkWriter.close).toHaveBeenCalledTimes(1)
  })

  it('case 3: a reopened ticket (no closedAt on re-read) is skipped, not counted', async () => {
    const docs = [
      makeTicketDoc('operatorFeedback/ticket-1'),
      makeTicketDoc('operatorFeedback/ticket-2', { reopened: true }),
      makeTicketDoc('operatorFeedback/ticket-3'),
    ]
    const { db, recursiveDelete, bulkWriter } = makeFakeDb(docs)

    await expect(purgeOldFeedbackSweep(db as unknown as Parameters<typeof purgeOldFeedbackSweep>[0])).resolves.toEqual({
      purged: 2,
      failed: 0,
      closeFailed: false,
    })
    expect(recursiveDelete).toHaveBeenCalledTimes(2)
    const deletedPaths = recursiveDelete.mock.calls.map((call) => (call[0] as { path: string }).path)
    expect(deletedPaths).not.toContain('operatorFeedback/ticket-2')
    expect(bulkWriter.close).toHaveBeenCalledTimes(1)
  })

  it('case 4: bulkWriter.close() rejecting is reported as closeFailed without masking other counts', async () => {
    const rereadError = new Error('14 UNAVAILABLE: transient')
    const docs = [
      makeTicketDoc('operatorFeedback/ticket-1'),
      makeTicketDoc('operatorFeedback/ticket-2', { rereadRejectsWith: rereadError }),
      makeTicketDoc('operatorFeedback/ticket-3'),
    ]
    const close = vi.fn().mockRejectedValue(new Error('close failed'))
    const { db } = makeFakeDb(docs, { close })

    await expect(purgeOldFeedbackSweep(db as unknown as Parameters<typeof purgeOldFeedbackSweep>[0])).resolves.toEqual({
      purged: 2,
      failed: 1,
      closeFailed: true,
    })
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('purgeOldFeedback end-to-end with runWithRetentionAlert (issue #433)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('case 5: a mid-sweep re-read failure still resolves and logs RETENTION_PURGE_FAILED failed=1 exactly once', async () => {
    const errorSpy = vi.spyOn(logger, 'error')
    const rereadError = new Error('14 UNAVAILABLE: transient')
    const docs = [
      makeTicketDoc('operatorFeedback/ticket-1'),
      makeTicketDoc('operatorFeedback/ticket-2', { rereadRejectsWith: rereadError }),
      makeTicketDoc('operatorFeedback/ticket-3'),
    ]
    const { db } = makeFakeDb(docs)

    const result = await runWithRetentionAlert(
      'purgeOldFeedback',
      () => purgeOldFeedbackSweep(db as unknown as Parameters<typeof purgeOldFeedbackSweep>[0]),
      purgeOldFeedbackFailedCount,
    )

    expect(result).toEqual({ purged: 2, failed: 1, closeFailed: false })

    const markerCalls = errorSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes(RETENTION_PURGE_FAILED_LOG_MARKER),
    )
    expect(markerCalls).toHaveLength(1)
    expect(markerCalls[0][0]).toBe(`${RETENTION_PURGE_FAILED_LOG_MARKER} job=purgeOldFeedback failed=1`)
  })
})

describe('purgeOldFeedbackFailedCount', () => {
  it('folds failed count and closeFailed into a single number', () => {
    expect(purgeOldFeedbackFailedCount({ failed: 0, closeFailed: false })).toBe(0)
    expect(purgeOldFeedbackFailedCount({ failed: 2, closeFailed: true })).toBe(3)
  })
})
