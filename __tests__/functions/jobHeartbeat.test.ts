/**
 * `withJobHeartbeat` — `functions/src/admin/jobHeartbeat.ts` (issue #430).
 * Same mocking style as `retentionPurgeAlert.test.ts`: a hand-rolled fake
 * `Firestore` (`vi.fn()` chains, no library) and `vi.spyOn(logger, 'warn')`
 * against the root Vitest alias for `firebase-functions/v2`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { logger } from 'firebase-functions/v2'
import { Timestamp } from 'firebase-admin/firestore'
import { withJobHeartbeat } from '../../functions/src/admin/jobHeartbeat'

function makeFakeDb(setImpl?: (path: string, data: unknown, opts: unknown) => Promise<void>) {
  const set = vi.fn(setImpl ?? (() => Promise.resolve(undefined)))
  const doc = vi.fn((path: string) => ({
    set: (data: unknown, opts: unknown) => set(path, data, opts),
  }))
  const db = { doc }
  return { db, doc, set }
}

const FIXED_NOW = Timestamp.fromMillis(1_700_000_000_000)
const now = () => FIXED_NOW

describe('withJobHeartbeat', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('happy path: writes lastStartAt then lastOkAt, and returns the job result', async () => {
    const { db, doc, set } = makeFakeDb()

    const result = await withJobHeartbeat(
      db as unknown as Parameters<typeof withJobHeartbeat>[0],
      'purgeOldFeedback',
      async () => ({ purged: 3 }),
      now,
    )

    expect(result).toEqual({ purged: 3 })
    expect(doc).toHaveBeenCalledWith('jobHeartbeats/purgeOldFeedback')
    expect(set).toHaveBeenCalledTimes(2)
    expect(set.mock.calls[0]).toEqual(['jobHeartbeats/purgeOldFeedback', { lastStartAt: FIXED_NOW }, { merge: true }])
    expect(set.mock.calls[1]).toEqual(['jobHeartbeats/purgeOldFeedback', { lastOkAt: FIXED_NOW }, { merge: true }])
  })

  it('run() throws: writes lastErrorAt (not lastOkAt) and rethrows the ORIGINAL error unchanged', async () => {
    const { db, set } = makeFakeDb()
    const original = new Error('boom')

    await expect(
      withJobHeartbeat(
        db as unknown as Parameters<typeof withJobHeartbeat>[0],
        'companyDeletionSweep',
        async () => {
          throw original
        },
        now,
      ),
    ).rejects.toBe(original)

    expect(set).toHaveBeenCalledTimes(2)
    expect(set.mock.calls[0]).toEqual(['jobHeartbeats/companyDeletionSweep', { lastStartAt: FIXED_NOW }, { merge: true }])
    expect(set.mock.calls[1]).toEqual(['jobHeartbeats/companyDeletionSweep', { lastErrorAt: FIXED_NOW }, { merge: true }])
  })

  it('a heartbeat write that itself throws does not change the job result (best-effort)', async () => {
    const { db, set } = makeFakeDb(() => Promise.reject(new Error('firestore unavailable')))
    const warnSpy = vi.spyOn(logger, 'warn')

    const result = await withJobHeartbeat(
      db as unknown as Parameters<typeof withJobHeartbeat>[0],
      'strandedAccountSweep',
      async () => ({ deleted: 1 }),
      now,
    )

    expect(result).toEqual({ deleted: 1 })
    // Both the start and ok writes were attempted (and both rejected) —
    // withJobHeartbeat swallowed both without altering the result.
    expect(set).toHaveBeenCalledTimes(2)
    expect(warnSpy).toHaveBeenCalledTimes(2)
    expect(warnSpy.mock.calls[0][0]).toContain('strandedAccountSweep')
    expect(warnSpy.mock.calls[0][0]).toContain('field=lastStartAt')
    expect(warnSpy.mock.calls[1][0]).toContain('field=lastOkAt')
  })

  it('a heartbeat write that itself throws does not change the job error on the throw path', async () => {
    const { db, set } = makeFakeDb(() => Promise.reject(new Error('firestore unavailable')))
    const warnSpy = vi.spyOn(logger, 'warn')
    const original = new Error('the real failure')

    await expect(
      withJobHeartbeat(
        db as unknown as Parameters<typeof withJobHeartbeat>[0],
        'purgeOldAuditLogs',
        async () => {
          throw original
        },
        now,
      ),
    ).rejects.toBe(original)

    expect(set).toHaveBeenCalledTimes(2)
    expect(warnSpy).toHaveBeenCalledTimes(2)
    expect(warnSpy.mock.calls[1][0]).toContain('field=lastErrorAt')
  })
})
