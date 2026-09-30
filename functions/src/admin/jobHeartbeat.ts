import { logger } from 'firebase-functions/v2';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { RetentionPurgeJob } from './retentionPurgeAlert';

/**
 * Every scheduled job that writes a heartbeat to `jobHeartbeats/{job}` —
 * issue #430. `RETENTION_PURGE_FAILED_LOG_MARKER`
 * (`./retentionPurgeAlert.ts`, issue #416) only fires when a job RUNS and
 * reports its own failure; it has no way to notice a job that never ran at
 * all (not deployed, Cloud Scheduler paused, a region move that silently
 * orphaned the trigger) or one that died before it could log anything
 * (timeout, an uncaught crash that killed the Cloud Run instance). This
 * heartbeat mechanism, paired with the watchdog in
 * `./checkJobHeartbeats.ts`, closes that gap: every job in this union
 * writes `lastStartAt`/`lastOkAt`/`lastErrorAt` to its own heartbeat
 * document, and a separate scheduled function periodically checks whether
 * those timestamps look healthy, independent of whether the job itself ever
 * got a chance to log anything.
 *
 * Includes the three `RetentionPurgeJob` jobs plus the two sweeps that
 * currently have no alerting at all, `companyDeletionSweep` and
 * `strandedAccountSweep` — see `JOB_HEARTBEAT_CONFIG` below for why they
 * can't share the retention jobs' weekly-cadence assumptions.
 */
export type HeartbeatJob = RetentionPurgeJob | 'companyDeletionSweep' | 'strandedAccountSweep';

/**
 * Per-job thresholds for the watchdog in `./checkJobHeartbeats.ts`.
 *
 *   - `maxAgeMs` — how old `lastOkAt` is allowed to get before the job is
 *     considered stale. Set from each job's own schedule with generous
 *     slack, not a shared constant, because the five jobs run on wildly
 *     different cadences (weekly retention sweeps vs. a sweep that runs
 *     every 30 minutes).
 *   - `timeoutSeconds` — the job's own `onSchedule` timeout (or, for the
 *     three retention jobs, today's IMPLICIT default of 60s: none of them
 *     sets `timeoutSeconds` explicitly, so Cloud Functions v2's own default
 *     applies. Made explicit here so the watchdog's `unfinished` rule below
 *     has a real number to add its 1-hour grace window to. Issue #435 will
 *     revisit whether 60s is actually enough headroom for these three jobs
 *     as their collections grow — not in scope here).
 *
 * Retention jobs run weekly (`purgeOldAuditLogs`, `purgeOldFeedback`,
 * `purgeCompanyDeletionLogs` all schedule for a specific day/time). 8 days
 * gives a full week plus a day of slack before `lastOkAt` is treated as
 * stale, so a single slow or delayed run doesn't immediately page anyone.
 *
 * `companyDeletionSweep` runs every 30 minutes and does real,
 * time-sensitive work (executing overdue company deletions, resuming stuck
 * purges) — 6 hours is generous relative to its cadence but still tight
 * enough to catch a genuinely broken sweep quickly. `timeoutSeconds: 540`
 * matches its existing `onSchedule` config.
 *
 * `strandedAccountSweep` runs every 24 hours — 2 days gives one full missed
 * run of slack before alarming. `timeoutSeconds: 300` matches its existing
 * `onSchedule` config.
 */
export const JOB_HEARTBEAT_CONFIG: Record<HeartbeatJob, { maxAgeMs: number; timeoutSeconds: number }> = {
  purgeOldFeedback: { maxAgeMs: 8 * 24 * 60 * 60 * 1000, timeoutSeconds: 60 },
  purgeOldAuditLogs: { maxAgeMs: 8 * 24 * 60 * 60 * 1000, timeoutSeconds: 60 },
  purgeCompanyDeletionLogs: { maxAgeMs: 8 * 24 * 60 * 60 * 1000, timeoutSeconds: 60 },
  companyDeletionSweep: { maxAgeMs: 6 * 60 * 60 * 1000, timeoutSeconds: 540 },
  strandedAccountSweep: { maxAgeMs: 2 * 24 * 60 * 60 * 1000, timeoutSeconds: 300 },
};

/**
 * `jobHeartbeats/{job}` holds only three Timestamp fields
 * (`lastStartAt`/`lastOkAt`/`lastErrorAt`) and a job name as the doc id —
 * no PII, ever. Written and read only by the Admin SDK; see
 * `firestore.rules`'s `match /jobHeartbeats/{doc}` for the client-side deny.
 *
 * "OK" here means the job's `run()` resolved without throwing — it does NOT
 * mean the job was error-free. A retention sweep can resolve with a nonzero
 * per-row failure count (see `RETENTION_PURGE_FAILED_LOG_MARKER`) and still
 * write `lastOkAt`, because from the heartbeat's point of view the job
 * finished and didn't hang or crash. Partial failures inside a run that
 * otherwise completes are `runWithRetentionAlert`'s job to catch, not this
 * one's — the two mechanisms watch different failure modes and are meant to
 * be read together, not as substitutes for each other.
 *
 * Wraps the ENTIRE job body, outermost — around `runWithRetentionAlert`
 * where a job also uses that helper, and around any post-run throw (e.g.
 * `purgeCompanyDeletionLogs`'s `if (result.failedRows > 0) throw`) — so a
 * heartbeat is written for every outcome the job can have, not just the
 * happy path inside some inner helper.
 *
 * Every heartbeat write (`lastStartAt`, `lastOkAt`, `lastErrorAt`) is
 * best-effort: wrapped in its own try/catch, logging only the job name and
 * the write error's message (no stack trace, no document content — nothing
 * here should ever carry PII) via `logger.warn`. A heartbeat write failing
 * must never change the job's own result or the error it throws, and must
 * never itself escape this function as a thrown error — a Firestore blip on
 * the heartbeat write is not a reason to fail (or falsely appear to fail) a
 * GDPR retention job or a destructive account-deletion sweep.
 */
export async function withJobHeartbeat<T>(
  db: Firestore,
  job: HeartbeatJob,
  run: () => Promise<T>,
  now: () => Timestamp = () => Timestamp.now(),
): Promise<T> {
  await writeHeartbeatField(db, job, 'lastStartAt', now());

  let result: T;
  try {
    result = await run();
  } catch (err) {
    await writeHeartbeatField(db, job, 'lastErrorAt', now());
    throw err;
  }

  await writeHeartbeatField(db, job, 'lastOkAt', now());
  return result;
}

async function writeHeartbeatField(
  db: Firestore,
  job: HeartbeatJob,
  field: 'lastStartAt' | 'lastOkAt' | 'lastErrorAt',
  value: Timestamp,
): Promise<void> {
  try {
    await db.doc(`jobHeartbeats/${job}`).set({ [field]: value }, { merge: true });
  } catch (err) {
    logger.warn(`jobHeartbeat: write failed job=${job} field=${field}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
