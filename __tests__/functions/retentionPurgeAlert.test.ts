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
import { runWithRetentionAlert, RETENTION_PURGE_FAILED_LOG_MARKER } from '../../functions/src/admin/retentionPurgeAlert'

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
})
