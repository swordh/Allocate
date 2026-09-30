/**
 * `evaluateHeartbeats` / `filterDeduped` / `runCheckJobHeartbeats` —
 * `functions/src/admin/checkJobHeartbeats.ts` (issue #430). Same mocking
 * style as `retentionPurgeAlert.test.ts` / `jobHeartbeat.test.ts`: a
 * hand-rolled fake Firestore (`vi.fn()` chains, no library) and
 * `vi.spyOn(logger, 'error'/'info'/'warn')` against the root Vitest alias
 * for `firebase-functions/v2`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { logger } from 'firebase-functions/v2'
import { Timestamp } from 'firebase-admin/firestore'
import {
  evaluateHeartbeats,
  filterDeduped,
  runCheckJobHeartbeats,
  JOB_STALE_LOG_MARKER,
  JOB_HEARTBEAT_CHECK_OK_LOG_MARKER,
  type HeartbeatDocSnapshot,
  type WatchdogState,
} from '../../functions/src/admin/checkJobHeartbeats'
import { JOB_HEARTBEAT_CONFIG, type HeartbeatJob } from '../../functions/src/admin/jobHeartbeat'

const ALL_JOBS = Object.keys(JOB_HEARTBEAT_CONFIG) as HeartbeatJob[]
const NOW_MS = 1_700_000_000_000
const ONE_HOUR_MS = 60 * 60 * 1000

function ts(millis: number): Timestamp {
  return Timestamp.fromMillis(millis)
}

/** Every job healthy: lastOkAt 1 minute ago, well inside every maxAgeMs. */
function healthyDocs(): Partial<Record<HeartbeatJob, HeartbeatDocSnapshot>> {
  const docs: Partial<Record<HeartbeatJob, HeartbeatDocSnapshot>> = {}
  for (const job of ALL_JOBS) {
    docs[job] = { lastStartAt: ts(NOW_MS - 60_000), lastOkAt: ts(NOW_MS - 30_000) }
  }
  return docs
}

function findingsFor(findings: ReturnType<typeof evaluateHeartbeats>, job: HeartbeatJob) {
  return findings.filter((f) => f.job === job)
}

describe('evaluateHeartbeats', () => {
  it('ok case: fresh lastOkAt produces no finding for that job', () => {
    const findings = evaluateHeartbeats(healthyDocs(), {}, NOW_MS)
    expect(findings).toEqual([])
  })

  describe('stale boundary (maxAgeMs)', () => {
    const job: HeartbeatJob = 'purgeOldFeedback'
    const maxAgeMs = JOB_HEARTBEAT_CONFIG[job].maxAgeMs

    it('just under maxAgeMs: no stale finding', () => {
      const docs = healthyDocs()
      docs[job] = { lastStartAt: ts(NOW_MS - maxAgeMs + 1000), lastOkAt: ts(NOW_MS - maxAgeMs + 1000) }
      const findings = evaluateHeartbeats(docs, {}, NOW_MS)
      expect(findingsFor(findings, job)).toEqual([])
    })

    it('exactly at maxAgeMs (age === maxAgeMs): no stale finding — the comparison is strictly >', () => {
      const docs = healthyDocs()
      docs[job] = { lastStartAt: ts(NOW_MS - maxAgeMs), lastOkAt: ts(NOW_MS - maxAgeMs) }
      const findings = evaluateHeartbeats(docs, {}, NOW_MS)
      expect(findingsFor(findings, job)).toEqual([])
    })

    it('just over maxAgeMs: stale finding', () => {
      const docs = healthyDocs()
      docs[job] = { lastStartAt: ts(NOW_MS - maxAgeMs - 1000), lastOkAt: ts(NOW_MS - maxAgeMs - 1000) }
      const findings = evaluateHeartbeats(docs, {}, NOW_MS)
      expect(findingsFor(findings, job)).toEqual([{ job, reason: 'stale' }])
    })
  })

  describe('missing heartbeat doc — bootstrap window', () => {
    const job: HeartbeatJob = 'purgeOldFeedback'
    const maxAgeMs = JOB_HEARTBEAT_CONFIG[job].maxAgeMs

    it('within the bootstrap period: no finding even with no doc at all', () => {
      const docs = healthyDocs()
      delete docs[job]
      const watchdog: WatchdogState = { firstRunAt: ts(NOW_MS - maxAgeMs + 1000) }
      const findings = evaluateHeartbeats(docs, watchdog, NOW_MS)
      expect(findingsFor(findings, job)).toEqual([])
    })

    it('exactly at the bootstrap boundary (age === maxAgeMs): no finding — the comparison is strictly >', () => {
      const docs = healthyDocs()
      delete docs[job]
      const watchdog: WatchdogState = { firstRunAt: ts(NOW_MS - maxAgeMs) }
      const findings = evaluateHeartbeats(docs, watchdog, NOW_MS)
      expect(findingsFor(findings, job)).toEqual([])
    })

    it('after the bootstrap period: stale finding', () => {
      const docs = healthyDocs()
      delete docs[job]
      const watchdog: WatchdogState = { firstRunAt: ts(NOW_MS - maxAgeMs - 1000) }
      const findings = evaluateHeartbeats(docs, watchdog, NOW_MS)
      expect(findingsFor(findings, job)).toEqual([{ job, reason: 'stale' }])
    })

    it('no firstRunAt at all (watchdog never ran before): no finding regardless of age', () => {
      const docs = healthyDocs()
      delete docs[job]
      const findings = evaluateHeartbeats(docs, {}, NOW_MS)
      expect(findingsFor(findings, job)).toEqual([])
    })
  })

  describe('unfinished boundary (timeoutSeconds + 1h)', () => {
    const job: HeartbeatJob = 'companyDeletionSweep'
    const thresholdMs = JOB_HEARTBEAT_CONFIG[job].timeoutSeconds * 1000 + ONE_HOUR_MS

    it('just under the threshold: no unfinished finding', () => {
      const docs = healthyDocs()
      // lastOkAt from a prior run, older than lastStartAt but still well
      // within maxAgeMs, so only the 'unfinished' boundary is exercised.
      docs[job] = {
        lastStartAt: ts(NOW_MS - thresholdMs + 1000),
        lastOkAt: ts(NOW_MS - thresholdMs + 1000 - 10_000),
      }
      const findings = evaluateHeartbeats(docs, {}, NOW_MS)
      expect(findingsFor(findings, job)).toEqual([])
    })

    it('exactly at the threshold (age === timeoutSeconds*1000+1h): no unfinished finding — the comparison is strictly >', () => {
      const docs = healthyDocs()
      docs[job] = {
        lastStartAt: ts(NOW_MS - thresholdMs),
        lastOkAt: ts(NOW_MS - thresholdMs - 10_000),
      }
      const findings = evaluateHeartbeats(docs, {}, NOW_MS)
      expect(findingsFor(findings, job)).toEqual([])
    })

    it('just over the threshold: unfinished finding', () => {
      const docs = healthyDocs()
      docs[job] = {
        lastStartAt: ts(NOW_MS - thresholdMs - 1000),
        lastOkAt: ts(NOW_MS - thresholdMs - 1000 - 10_000),
      }
      const findings = evaluateHeartbeats(docs, {}, NOW_MS)
      expect(findingsFor(findings, job)).toEqual([{ job, reason: 'unfinished' }])
    })
  })

  describe('failed, and self-healing', () => {
    const job: HeartbeatJob = 'strandedAccountSweep'

    it('lastErrorAt after lastOkAt: failed finding', () => {
      const docs = healthyDocs()
      docs[job] = {
        lastStartAt: ts(NOW_MS - 120_000),
        lastOkAt: ts(NOW_MS - 300_000),
        lastErrorAt: ts(NOW_MS - 60_000),
      }
      const findings = evaluateHeartbeats(docs, {}, NOW_MS)
      expect(findingsFor(findings, job)).toEqual([{ job, reason: 'failed' }])
    })

    it('lastErrorAt exists but a LATER lastOkAt self-heals it: no finding', () => {
      const docs = healthyDocs()
      docs[job] = {
        lastStartAt: ts(NOW_MS - 60_000),
        lastOkAt: ts(NOW_MS - 30_000),
        lastErrorAt: ts(NOW_MS - 300_000),
      }
      const findings = evaluateHeartbeats(docs, {}, NOW_MS)
      expect(findingsFor(findings, job)).toEqual([])
    })

    it('lastErrorAt with no lastOkAt at all: failed finding', () => {
      const docs = healthyDocs()
      docs[job] = { lastStartAt: ts(NOW_MS - 60_000), lastErrorAt: ts(NOW_MS - 30_000) }
      const findings = evaluateHeartbeats(docs, {}, NOW_MS)
      expect(findingsFor(findings, job)).toEqual([{ job, reason: 'failed' }])
    })
  })

  describe('precedence: unfinished beats failed beats stale', () => {
    const job: HeartbeatJob = 'purgeOldAuditLogs'
    const config = JOB_HEARTBEAT_CONFIG[job]

    it('a job that is simultaneously unfinished-eligible and failed-eligible only emits unfinished', () => {
      const docs = healthyDocs()
      const thresholdMs = config.timeoutSeconds * 1000 + ONE_HOUR_MS
      docs[job] = {
        // Started long enough ago to be 'unfinished' ...
        lastStartAt: ts(NOW_MS - thresholdMs - 1000),
        // ... but there's also an old error sitting there with no lastOkAt
        // after it, which in isolation would satisfy the 'failed' rule too.
        lastErrorAt: ts(NOW_MS - thresholdMs - 2000),
      }
      const findings = evaluateHeartbeats(docs, {}, NOW_MS)
      expect(findingsFor(findings, job)).toEqual([{ job, reason: 'unfinished' }])
    })

    it('a job that is simultaneously failed-eligible and stale-eligible only emits failed', () => {
      const docs = healthyDocs()
      docs[job] = {
        lastStartAt: ts(NOW_MS - config.maxAgeMs - 1000),
        lastErrorAt: ts(NOW_MS - config.maxAgeMs - 1000),
        // no lastOkAt at all — also 'stale'-eligible on its own.
      }
      const findings = evaluateHeartbeats(docs, {}, NOW_MS)
      expect(findingsFor(findings, job)).toEqual([{ job, reason: 'failed' }])
    })
  })
})

describe('filterDeduped', () => {
  it('suppresses the same (job, reason) finding within 24h', () => {
    const findings = [{ job: 'purgeOldFeedback' as HeartbeatJob, reason: 'stale' as const }]
    const lastAlertedAt = { 'purgeOldFeedback:stale': NOW_MS - 60_000 }
    const { toLog, updates } = filterDeduped(findings, lastAlertedAt, NOW_MS)
    expect(toLog).toEqual([])
    expect(updates).toEqual({})
  })

  it('exactly at the 24h boundary (age === 24h): still suppressed — the comparison is strictly >', () => {
    const findings = [{ job: 'purgeOldFeedback' as HeartbeatJob, reason: 'stale' as const }]
    const lastAlertedAt = { 'purgeOldFeedback:stale': NOW_MS - 24 * 60 * 60 * 1000 }
    const { toLog, updates } = filterDeduped(findings, lastAlertedAt, NOW_MS)
    expect(toLog).toEqual([])
    expect(updates).toEqual({})
  })

  it('logs again once 24h has passed', () => {
    const findings = [{ job: 'purgeOldFeedback' as HeartbeatJob, reason: 'stale' as const }]
    const lastAlertedAt = { 'purgeOldFeedback:stale': NOW_MS - 24 * 60 * 60 * 1000 - 1000 }
    const { toLog, updates } = filterDeduped(findings, lastAlertedAt, NOW_MS)
    expect(toLog).toEqual(findings)
    expect(updates).toEqual({ 'purgeOldFeedback:stale': NOW_MS })
  })

  it('a finding never alerted before is not suppressed', () => {
    const findings = [{ job: 'purgeOldFeedback' as HeartbeatJob, reason: 'stale' as const }]
    const { toLog, updates } = filterDeduped(findings, {}, NOW_MS)
    expect(toLog).toEqual(findings)
    expect(updates).toEqual({ 'purgeOldFeedback:stale': NOW_MS })
  })

  it('writing one dedupe key does not report/clobber a sibling key in its own output', () => {
    const findings = [{ job: 'purgeOldFeedback' as HeartbeatJob, reason: 'stale' as const }]
    const lastAlertedAt = {
      'purgeOldFeedback:stale': NOW_MS - 25 * 60 * 60 * 1000,
      'companyDeletionSweep:failed': NOW_MS - 1000,
    }
    const { updates } = filterDeduped(findings, lastAlertedAt, NOW_MS)
    // Only the key for the finding that actually fired is in `updates` —
    // the sibling key is untouched by this function; the no-clobber
    // guarantee for the sibling is Firestore's nested-map merge semantics,
    // exercised end-to-end in the `runCheckJobHeartbeats` suite below.
    expect(Object.keys(updates)).toEqual(['purgeOldFeedback:stale'])
  })
})

describe('exact marker strings', () => {
  it('JOB_STALE', () => {
    expect(JOB_STALE_LOG_MARKER).toBe('JOB_STALE')
  })
  it('JOB_HEARTBEAT_CHECK_OK', () => {
    expect(JOB_HEARTBEAT_CHECK_OK_LOG_MARKER).toBe('JOB_HEARTBEAT_CHECK_OK')
  })
})

/**
 * In-memory fake Firestore for `runCheckJobHeartbeats`. `set(data, {merge:
 * true})` performs a real nested-map merge (matching documented Firestore
 * `set`-with-`merge` semantics: a nested map field is merged key-by-key,
 * not replaced wholesale) — this is exactly the behavior
 * `checkJobHeartbeats.ts`'s dedupe write relies on, and the "sibling key
 * survives" test below would fail if this fake instead did a shallow
 * top-level overwrite of `lastAlertedAt`.
 */
function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === 'object' &&
      !(value instanceof Timestamp) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !(result[key] instanceof Timestamp)
    ) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }
  return result
}

function makeFakeFirestore(initial: Record<string, Record<string, unknown>> = {}) {
  const store = new Map<string, Record<string, unknown>>(Object.entries(initial))
  const doc = vi.fn((path: string) => ({
    get: vi.fn(async () => {
      const data = store.get(path)
      return {
        exists: data !== undefined,
        data: () => data,
      }
    }),
    set: vi.fn(async (patch: Record<string, unknown>, opts?: { merge?: boolean }) => {
      const existing = store.get(path) ?? {}
      store.set(path, opts?.merge ? deepMerge(existing, patch) : patch)
    }),
  }))
  return { db: { doc }, store }
}

describe('runCheckJobHeartbeats', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('logs JOB_STALE for a finding and JOB_HEARTBEAT_CHECK_OK after both evaluation and the state write succeed', async () => {
    const errorSpy = vi.spyOn(logger, 'error')
    const infoSpy = vi.spyOn(logger, 'info')
    const staleMillis = NOW_MS - JOB_HEARTBEAT_CONFIG.purgeOldFeedback.maxAgeMs - 1000
    const initial: Record<string, Record<string, unknown>> = {
      'jobHeartbeats/_watchdog': { firstRunAt: ts(NOW_MS - 30 * 24 * 60 * 60 * 1000), lastAlertedAt: {} },
    }
    for (const job of ALL_JOBS) {
      initial[`jobHeartbeats/${job}`] =
        job === 'purgeOldFeedback' ? { lastOkAt: ts(staleMillis) } : { lastOkAt: ts(NOW_MS - 30_000) }
    }
    const { db, store } = makeFakeFirestore(initial)

    await runCheckJobHeartbeats(db as unknown as Parameters<typeof runCheckJobHeartbeats>[0], NOW_MS)

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0][0]).toBe(`${JOB_STALE_LOG_MARKER} job=purgeOldFeedback reason=stale`)

    const okCall = infoSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].startsWith(JOB_HEARTBEAT_CHECK_OK_LOG_MARKER))
    expect(okCall).toBeDefined()
    // `checked` is the number of jobs in JOB_HEARTBEAT_CONFIG (ALL_JOBS.length,
    // currently 5) — NOT the number of findings. `findings` and `logged` are
    // both 1 here since nothing was deduped on this first run.
    expect(okCall![0]).toBe(`${JOB_HEARTBEAT_CHECK_OK_LOG_MARKER} checked=${ALL_JOBS.length} findings=1 logged=1`)

    const watchdogDoc = store.get('jobHeartbeats/_watchdog')
    expect((watchdogDoc?.lastAlertedAt as Record<string, number>)['purgeOldFeedback:stale']).toBe(NOW_MS)
  })

  it('writing one dedupe key does not clobber a sibling key already in lastAlertedAt (Firestore nested-map merge)', async () => {
    const staleMillis = NOW_MS - JOB_HEARTBEAT_CONFIG.purgeOldFeedback.maxAgeMs - 1000
    const priorSiblingTimestamp = NOW_MS - 1000
    const initial: Record<string, Record<string, unknown>> = {
      'jobHeartbeats/_watchdog': {
        firstRunAt: ts(NOW_MS - 30 * 24 * 60 * 60 * 1000),
        lastAlertedAt: { 'companyDeletionSweep:failed': priorSiblingTimestamp },
      },
    }
    for (const job of ALL_JOBS) {
      initial[`jobHeartbeats/${job}`] =
        job === 'purgeOldFeedback' ? { lastOkAt: ts(staleMillis) } : { lastOkAt: ts(NOW_MS - 30_000) }
    }
    const { db, store } = makeFakeFirestore(initial)

    await runCheckJobHeartbeats(db as unknown as Parameters<typeof runCheckJobHeartbeats>[0], NOW_MS)

    const watchdogDoc = store.get('jobHeartbeats/_watchdog')
    const lastAlertedAt = watchdogDoc?.lastAlertedAt as Record<string, number>
    // The new key was written ...
    expect(lastAlertedAt['purgeOldFeedback:stale']).toBe(NOW_MS)
    // ... and the pre-existing sibling key from a previous run is untouched.
    expect(lastAlertedAt['companyDeletionSweep:failed']).toBe(priorSiblingTimestamp)
  })

  it('dedupe suppresses a repeat finding within 24h across two runs', async () => {
    const staleMillis = NOW_MS - JOB_HEARTBEAT_CONFIG.purgeOldFeedback.maxAgeMs - 1000
    const initial: Record<string, Record<string, unknown>> = {
      'jobHeartbeats/_watchdog': { firstRunAt: ts(NOW_MS - 30 * 24 * 60 * 60 * 1000), lastAlertedAt: {} },
    }
    for (const job of ALL_JOBS) {
      initial[`jobHeartbeats/${job}`] =
        job === 'purgeOldFeedback' ? { lastOkAt: ts(staleMillis) } : { lastOkAt: ts(NOW_MS - 30_000) }
    }
    const { db } = makeFakeFirestore(initial)

    const errorSpy = vi.spyOn(logger, 'error')
    const infoSpy = vi.spyOn(logger, 'info')
    await runCheckJobHeartbeats(db as unknown as Parameters<typeof runCheckJobHeartbeats>[0], NOW_MS)
    expect(errorSpy).toHaveBeenCalledTimes(1)

    // Second run, one hour later — well within the 24h dedupe window, same
    // underlying stale condition. The finding is still real (evaluateHeartbeats
    // reports it again), but filterDeduped suppresses logging it a second time
    // — so `findings` and `logged` diverge on this run, and both differ from
    // `checked` (the constant job count), exercising all three counts at once.
    errorSpy.mockClear()
    infoSpy.mockClear()
    await runCheckJobHeartbeats(db as unknown as Parameters<typeof runCheckJobHeartbeats>[0], NOW_MS + ONE_HOUR_MS)
    expect(errorSpy).not.toHaveBeenCalled()

    const okCall = infoSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].startsWith(JOB_HEARTBEAT_CHECK_OK_LOG_MARKER))
    expect(okCall).toBeDefined()
    expect(okCall![0]).toBe(`${JOB_HEARTBEAT_CHECK_OK_LOG_MARKER} checked=${ALL_JOBS.length} findings=1 logged=0`)
  })

  it('does not log JOB_STALE or JOB_HEARTBEAT_CHECK_OK when every job is healthy', async () => {
    const initial: Record<string, Record<string, unknown>> = {
      'jobHeartbeats/_watchdog': { firstRunAt: ts(NOW_MS - 30 * 24 * 60 * 60 * 1000), lastAlertedAt: {} },
    }
    for (const job of ALL_JOBS) {
      initial[`jobHeartbeats/${job}`] = { lastOkAt: ts(NOW_MS - 30_000) }
    }
    const { db } = makeFakeFirestore(initial)
    const errorSpy = vi.spyOn(logger, 'error')
    const infoSpy = vi.spyOn(logger, 'info')

    await runCheckJobHeartbeats(db as unknown as Parameters<typeof runCheckJobHeartbeats>[0], NOW_MS)

    expect(errorSpy).not.toHaveBeenCalled()
    const okCall = infoSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].startsWith(JOB_HEARTBEAT_CHECK_OK_LOG_MARKER))
    expect(okCall![0]).toBe(`${JOB_HEARTBEAT_CHECK_OK_LOG_MARKER} checked=${ALL_JOBS.length} findings=0 logged=0`)
  })

  it('still logs JOB_STALE finding lines when the state write fails, but withholds JOB_HEARTBEAT_CHECK_OK', async () => {
    const staleMillis = NOW_MS - JOB_HEARTBEAT_CONFIG.purgeOldFeedback.maxAgeMs - 1000
    const initial: Record<string, Record<string, unknown>> = {
      'jobHeartbeats/_watchdog': { firstRunAt: ts(NOW_MS - 30 * 24 * 60 * 60 * 1000), lastAlertedAt: {} },
    }
    for (const job of ALL_JOBS) {
      initial[`jobHeartbeats/${job}`] =
        job === 'purgeOldFeedback' ? { lastOkAt: ts(staleMillis) } : { lastOkAt: ts(NOW_MS - 30_000) }
    }
    const { db } = makeFakeFirestore(initial)
    // Force the state write to fail.
    const originalDoc = db.doc
    db.doc = vi.fn((path: string) => {
      const real = originalDoc(path)
      if (path === 'jobHeartbeats/_watchdog') {
        return { ...real, set: vi.fn(async () => Promise.reject(new Error('write failed'))) }
      }
      return real
    })

    const errorSpy = vi.spyOn(logger, 'error')
    const infoSpy = vi.spyOn(logger, 'info')
    const warnSpy = vi.spyOn(logger, 'warn')

    await runCheckJobHeartbeats(db as unknown as Parameters<typeof runCheckJobHeartbeats>[0], NOW_MS)

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0][0]).toBe(`${JOB_STALE_LOG_MARKER} job=purgeOldFeedback reason=stale`)
    const okCall = infoSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].startsWith(JOB_HEARTBEAT_CHECK_OK_LOG_MARKER))
    expect(okCall).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('propagates the error and logs no OK line when reading the heartbeat docs itself throws', async () => {
    const { db } = makeFakeFirestore({})
    const readError = new Error('firestore read failed')
    db.doc = vi.fn(() => ({
      get: vi.fn(async () => {
        throw readError
      }),
      set: vi.fn(async () => undefined),
    }))

    const infoSpy = vi.spyOn(logger, 'info')

    await expect(
      runCheckJobHeartbeats(db as unknown as Parameters<typeof runCheckJobHeartbeats>[0], NOW_MS),
    ).rejects.toBe(readError)

    const okCall = infoSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].startsWith(JOB_HEARTBEAT_CHECK_OK_LOG_MARKER))
    expect(okCall).toBeUndefined()
  })
})
