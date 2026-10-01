/**
 * `runWithRetentionAlert` — `functions/src/admin/retentionPurgeAlert.ts`
 * (issue #416). Shared by the `onSchedule` wrappers of `purgeOldFeedback`,
 * `purgeOldAuditLogs` and `purgeCompanyDeletionLogs`: logs the
 * `RETENTION_PURGE_FAILED` marker exactly once, as a plain single-line
 * string, whenever a sweep reports a failure count above zero or throws
 * outright — the same marker-matching pattern as
 * `lib/memberAnonymisationAlert.ts` / `lib/accountDeletionAlert.ts`, whose
 * Cloud Monitoring policies match on a literal string in the log entry.
 *
 * `logger` here resolves to the root Vitest alias
 * (`__tests__/__mocks__/firebase-functions-v2.ts`) — a plain mutable object
 * built for `vi.spyOn`, not a vi.mock() factory.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { logger } from 'firebase-functions/v2'
import {
  runWithRetentionAlert,
  retentionDeadline,
  RETENTION_PURGE_FAILED_LOG_MARKER,
  RETENTION_BUDGET_MARGIN_SECONDS,
} from '../../functions/src/admin/retentionPurgeAlert'
import { JOB_HEARTBEAT_CONFIG } from '../../functions/src/admin/jobHeartbeat'

describe('runWithRetentionAlert', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('failed > 0 — logs exactly one marker line and passes the result through', async () => {
    const errorSpy = vi.spyOn(logger, 'error')

    const result = await runWithRetentionAlert(
      'purgeOldFeedback',
      async () => ({ purged: 3, failed: 2 }),
      (r) => r.failed,
    )

    expect(result).toEqual({ purged: 3, failed: 2 })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const [arg] = errorSpy.mock.calls[0]
    expect(typeof arg).toBe('string')
    expect(arg).toBe(`${RETENTION_PURGE_FAILED_LOG_MARKER} job=purgeOldFeedback failed=2`)
  })

  it('failed = 0 — logs nothing', async () => {
    const errorSpy = vi.spyOn(logger, 'error')

    const result = await runWithRetentionAlert(
      'purgeOldAuditLogs',
      async () => ({ purged: 5 }),
      () => 0,
    )

    expect(result).toEqual({ purged: 5 })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('run() throws — logs exactly one marker line and rethrows the SAME error object', async () => {
    const errorSpy = vi.spyOn(logger, 'error')
    const original = new Error('permission-denied: could not commit batch')

    await expect(
      runWithRetentionAlert(
        'purgeCompanyDeletionLogs',
        async () => {
          throw original
        },
        () => 0,
      ),
    ).rejects.toBe(original)

    expect(errorSpy).toHaveBeenCalledTimes(1)
    const [arg] = errorSpy.mock.calls[0]
    expect(typeof arg).toBe('string')
    expect(arg).toBe(
      `${RETENTION_PURGE_FAILED_LOG_MARKER} job=purgeCompanyDeletionLogs error=permission-denied: could not commit batch`,
    )
  })

  it('a multi-line/long error message is collapsed to a single line and truncated', async () => {
    const errorSpy = vi.spyOn(logger, 'error')
    const longMessage = `first line\nsecond line\t\twith tabs\n${'x'.repeat(400)}`
    const collapsed = longMessage.replace(/\s+/g, ' ').trim()
    const expectedTruncated = `${collapsed.slice(0, 300)}…`

    await expect(
      runWithRetentionAlert(
        'purgeOldFeedback',
        async () => {
          throw new Error(longMessage)
        },
        () => 0,
      ),
    ).rejects.toThrow()

    expect(errorSpy).toHaveBeenCalledTimes(1)
    const [arg] = errorSpy.mock.calls[0] as [string]
    expect(arg).toBe(`${RETENTION_PURGE_FAILED_LOG_MARKER} job=purgeOldFeedback error=${expectedTruncated}`)
    expect(arg).not.toContain('\n')
    // Marker + job= + error= prefix plus a ~300-char truncated body — well
    // short of the ~500+ chars the raw message would have produced.
    expect(arg.length).toBeLessThan(400)
  })

  it('unfinished > 0, failed = 0 — logs one marker line with the unfinished suffix (issue #435)', async () => {
    const errorSpy = vi.spyOn(logger, 'error')

    const result = await runWithRetentionAlert(
      'purgeOldFeedback',
      async () => ({ purged: 3, failed: 0, unfinished: 4 }),
      () => 0,
      (r) => r.unfinished,
    )

    expect(result).toEqual({ purged: 3, failed: 0, unfinished: 4 })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0][0]).toBe(`${RETENTION_PURGE_FAILED_LOG_MARKER} job=purgeOldFeedback failed=0 unfinished=4`)
  })

  it('unfinished = 0 with unfinishedCount passed — format is byte-for-byte identical to a caller that omits it', async () => {
    const errorSpy = vi.spyOn(logger, 'error')

    await runWithRetentionAlert(
      'purgeOldAuditLogs',
      async () => ({ purged: 5, failed: 2, unfinished: 0 }),
      (r) => r.failed,
      (r) => r.unfinished,
    )

    expect(errorSpy).toHaveBeenCalledTimes(1)
    // No trailing ` unfinished=` suffix at all when the count is zero — the
    // existing "failed > 0" tests above assert this exact format with no
    // fourth argument, and it must not change shape just because a caller
    // now passes one.
    expect(errorSpy.mock.calls[0][0]).toBe(`${RETENTION_PURGE_FAILED_LOG_MARKER} job=purgeOldAuditLogs failed=2`)
  })

  it('failed = 0 and unfinishedCount omitted entirely — logs nothing, matching every caller written before #435', async () => {
    const errorSpy = vi.spyOn(logger, 'error')

    const result = await runWithRetentionAlert('purgeOldFeedback', async () => ({ purged: 9 }), () => 0)

    expect(result).toEqual({ purged: 9 })
    expect(errorSpy).not.toHaveBeenCalled()
  })
})

describe('retentionDeadline (issue #435)', () => {
  const job = 'purgeOldFeedback' as const
  const budgetMs = (JOB_HEARTBEAT_CONFIG[job].timeoutSeconds - RETENTION_BUDGET_MARGIN_SECONDS) * 1000

  it('margin constant is 60 seconds', () => {
    expect(RETENTION_BUDGET_MARGIN_SECONDS).toBe(60)
  })

  it('just under the deadline: not exceeded', () => {
    const startMs = 1_000_000
    const deadlineExceeded = retentionDeadline(job, startMs, () => startMs + budgetMs - 1)
    expect(deadlineExceeded()).toBe(false)
  })

  it('exactly at the deadline: exceeded — the comparison is >=', () => {
    const startMs = 1_000_000
    const deadlineExceeded = retentionDeadline(job, startMs, () => startMs + budgetMs)
    expect(deadlineExceeded()).toBe(true)
  })

  it('just over the deadline: exceeded', () => {
    const startMs = 1_000_000
    const deadlineExceeded = retentionDeadline(job, startMs, () => startMs + budgetMs + 1)
    expect(deadlineExceeded()).toBe(true)
  })

  it('re-evaluates nowFn on every call rather than freezing at construction time', () => {
    const startMs = 1_000_000
    let now = startMs
    const deadlineExceeded = retentionDeadline(job, startMs, () => now)
    expect(deadlineExceeded()).toBe(false)
    now = startMs + budgetMs
    expect(deadlineExceeded()).toBe(true)
  })
})
