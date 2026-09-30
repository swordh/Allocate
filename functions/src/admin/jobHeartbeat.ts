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
 *
 * Known gap: `jobHeartbeats/{job}` keeps only the LATEST
 * `lastStartAt`/`lastOkAt`/`lastErrorAt`, not a history of runs. A run that
 * fails at run N and self-heals with a success at run N+1 — before the
 * watchdog's next 6-hourly check happens to land between those two runs —
 * leaves no trace at all: `lastOkAt` from run N+1 simply overwrites whatever
 * `lastErrorAt` run N wrote, and `evaluateHeartbeats`' `failed` rule never
 * sees the failure. This is intentional, not an oversight: this mechanism
 * exists to catch a job that is PERSISTENTLY broken (never runs, hangs, or
 * fails repeatedly with no recovery), not to audit every individual run —
 * that's a different, higher-cardinality problem. A single transient failure
 * that resolves itself before the next watchdog check is, by design, not
 * something this mechanism reports. Per-run failure visibility is covered
 * separately, and only for the three retention jobs, by
 * `RETENTION_PURGE_FAILED_LOG_MARKER` (`./retentionPurgeAlert.ts`) — which
 * fires synchronously on every failing run, not just persistent ones.
 * `companyDeletionSweep` and `strandedAccountSweep` have no equivalent
 * per-run signal; a transient failure in either is only visible here if it
 * happens to coincide with a watchdog check landing between the failing run
 * and its self-healing successor.
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
 *   - `timeoutSeconds` — the job's own `onSchedule` timeout. THIS IS THE
 *     SOURCE OF TRUTH: all five `onSchedule` configs (`purgeAuditLogs.ts`,
 *     `purgeOldFeedback.ts`, `../company/purgeLogs.ts`, `../company/sweep.ts`,
 *     `../company/strandedAccountSweep.ts`) set their `timeoutSeconds` option
 *     by reading it from this config rather than hardcoding a literal, so the
 *     watchdog's `unfinished` grace window and the job's ACTUAL deployed
 *     Cloud Run timeout can never silently drift apart. Practically: changing
 *     a value here changes the deployed function's timeout on the next
 *     deploy, not just the watchdog's expectations — issue #435 raised the
 *     three retention jobs from 60s to 540s so they now match
 *     `company/sweep.ts`'s existing timeout, giving them the same headroom as
 *     their collections grow. `./retentionPurgeAlert.ts`'s `retentionDeadline`
 *     reads this same `timeoutSeconds` (minus a margin) to give each sweep a
 *     wall-clock budget to stop cleanly BEFORE the platform kills it — see
 *     that file's docblock.
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
  purgeOldFeedback: { maxAgeMs: 8 * 24 * 60 * 60 * 1000, timeoutSeconds: 540 },
  purgeOldAuditLogs: { maxAgeMs: 8 * 24 * 60 * 60 * 1000, timeoutSeconds: 540 },
  purgeCompanyDeletionLogs: { maxAgeMs: 8 * 24 * 60 * 60 * 1000, timeoutSeconds: 540 },
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
