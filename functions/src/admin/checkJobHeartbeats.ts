import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { JOB_HEARTBEAT_CONFIG, type HeartbeatJob } from './jobHeartbeat';

/**
 * Filter marker for the Cloud Monitoring log-based alert policy (issue
 * #430) that fires when a scheduled job looks unhealthy by its own
 * heartbeat, regardless of whether the job itself ever logged anything.
 * Matches on
 * `textPayload:"JOB_STALE" OR jsonPayload.message:"JOB_STALE"` — see
 * `RETENTION_PURGE_FAILED_LOG_MARKER` (`./retentionPurgeAlert.ts`) for why
 * the filter covers both payload fields: whether a plain-string
 * `logger.error()` call from this runtime lands in `textPayload` or
 * `jsonPayload.message` is UNVERIFIED here too, for the exact same reason —
 * nobody has confirmed it for `firebase-functions/v2`'s `logger` the way
 * `lib/memberAnonymisationAlert.ts` / `lib/accountDeletionAlert.ts` confirmed
 * it for Next.js App Hosting's console. Confirm on alpha once deployed
 * (trigger a stale/unfinished/failed finding, read the raw log entry) and
 * narrow the filter and this comment accordingly.
 *
 * Keep the log a plain string, and don't rename this constant or change its
 * value without updating the alert policy in every environment — a rename
 * silently breaks the alert with no local signal anything is wrong.
 */
export const JOB_STALE_LOG_MARKER = 'JOB_STALE';

/**
 * Logged once per check, after BOTH the evaluation and the watchdog's own
 * state write (dedupe timestamps, `firstRunAt` bootstrap marker) succeed —
 * see `checkJobHeartbeats`'s docblock below for why the state write must
 * also succeed before this line is allowed to appear. The line carries three
 * counts, deliberately distinct: `checked=<n>` is the number of jobs in
 * `JOB_HEARTBEAT_CONFIG` this run evaluated (a constant, currently 5, not a
 * count of findings); `findings=<n>` is how many of those jobs produced a
 * finding (`evaluateHeartbeats`'s full, undeduped output); `logged=<n>` is
 * how many of those findings actually got a `JOB_STALE` line this run after
 * the 24h dedupe filter (`filterDeduped`'s `toLog`). `logged` can be lower
 * than `findings` when a finding is being suppressed as a repeat within the
 * dedupe window — that's expected, not a bug. Not currently wired
 * to an alert policy (an ABSENCE-style policy on this line would need to
 * tolerate the same 23.5h cap this whole mechanism exists to work around —
 * see `checkJobHeartbeats`'s docblock) but kept as a single stable string
 * so one could be added later, and so a human reading Cloud Logging can
 * positively confirm the watchdog itself is alive rather than inferring it
 * from the absence of `JOB_STALE` lines.
 */
export const JOB_HEARTBEAT_CHECK_OK_LOG_MARKER = 'JOB_HEARTBEAT_CHECK_OK';

const WATCHDOG_DOC_PATH = 'jobHeartbeats/_watchdog';

/** One `JOB_STALE` finding for one job. At most one per job per check — see `evaluateHeartbeats`'s docblock on precedence. */
export interface HeartbeatFinding {
  job: HeartbeatJob;
  reason: 'unfinished' | 'failed' | 'stale';
}

/** The shape `evaluateHeartbeats` reads per job — a `jobHeartbeats/{job}` doc, or `undefined` if none exists yet. */
export interface HeartbeatDocSnapshot {
  lastStartAt?: Timestamp;
  lastOkAt?: Timestamp;
  lastErrorAt?: Timestamp;
}

/** The `jobHeartbeats/_watchdog` doc's own persisted state. */
export interface WatchdogState {
  /** Set on the watchdog's very first run and never changed again — see the bootstrap rule below. */
  firstRunAt?: Timestamp;
  /** Keyed `"<job>:<reason>"` — when that (job, reason) finding was last logged, for the 24h dedupe window. Millis, not Timestamp — see docblock. */
  lastAlertedAt?: Record<string, number>;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

function toMillis(ts: Timestamp | undefined): number {
  return ts ? ts.toMillis() : 0;
}

/**
 * Pure evaluation of every configured job's heartbeat doc against the
 * current time — no Firestore or `onSchedule` dependency, so tests exercise
 * this directly with hand-built snapshots. `checkJobHeartbeats` below is
 * the thin wrapper that reads `jobHeartbeats/*` from Firestore, calls this,
 * and persists the dedupe/bootstrap state this function's caller is
 * responsible for filtering through (`dedupe` below).
 *
 * `docs` maps every `HeartbeatJob` to its heartbeat doc snapshot, or
 * `undefined` if the doc doesn't exist yet (a job that has never run since
 * this mechanism shipped, or a brand-new environment). `watchdog` is the
 * `_watchdog` doc's own state — used only for the bootstrap rule here;
 * dedupe filtering happens in the caller (`filterDeduped` below), not here,
 * so this function's output is always the FULL set of findings a snapshot
 * in time produces, before dedupe suppresses any of them.
 *
 * Per-job rule precedence — evaluated in this order, first match wins, AT
 * Most one finding per job:
 *
 *   0. In-progress grace (not itself a finding) — if the job started more
 *      recently than it last finished (successfully or not) and is still
 *      within its own `timeoutSeconds` plus an hour of grace, NOTHING is
 *      reported for this job this check, regardless of how old `lastOkAt` or
 *      `lastErrorAt` is. A run that is genuinely still executing — including
 *      a job's very first-ever run, which has only `lastStartAt` and no
 *      `lastOkAt`/`lastErrorAt` at all — deserves a reprieve until it either
 *      finishes or overruns its grace window, not an immediate `stale` or
 *      `failed` finding just because nothing has landed yet. See the
 *      in-progress check in the loop below for the exact condition.
 *   1. `unfinished` — the job started more recently than it last finished
 *      (successfully or not), and it's been running long enough that even
 *      its own `timeoutSeconds` plus an hour of grace has elapsed. This
 *      takes precedence over `failed` and `stale` because it describes a
 *      DIFFERENT and more urgent failure mode than either: the process
 *      itself may be hung or dead (a Cloud Run instance that crashed before
 *      `withJobHeartbeat`'s catch block could write `lastErrorAt`, or a
 *      genuine timeout), not merely a job that ran and then failed cleanly.
 *      A `lastErrorAt` from some PREVIOUS run sitting there does not change
 *      this — that error is stale news next to a run that is currently
 *      stuck.
 *   2. `failed` — the most recent completed run (by either timestamp)
 *      errored and no later success has landed. Self-heals automatically:
 *      the moment a subsequent run writes `lastOkAt` after that
 *      `lastErrorAt`, this rule stops matching with no operator action.
 *      Takes precedence over `stale` because a fresh, specific failure is
 *      more actionable than a generic "hasn't succeeded in N days" — the
 *      latter is exactly what a `failed` state looks like from a distance,
 *      so reporting both would just be the same underlying problem twice.
 *   3. `stale` — `lastOkAt` is missing, or older than the job's
 *      `maxAgeMs`. The fallback: a job with no requirement start
 *      or a hung run, and no known cause, just hasn't checked in recently.
 *
 * Bootstrap: a job with NO heartbeat doc at all (the most common case right
 * after this mechanism first deploys, or in a brand-new environment before
 * any job has run once) is not immediately reported as `stale` — that would
 * false-alarm on every job the instant this watchdog itself starts running,
 * before any of them has had a fair chance to write a heartbeat. Instead,
 * `watchdog.firstRunAt` (persisted by the caller on the watchdog's own very
 * first run) gates it: a missing heartbeat doc only produces a `stale`
 * finding once `now - firstRunAt > maxAgeMs` for THAT job. Before that, no
 * finding is emitted for a missing doc at all — not even after the job's
 * own schedule would normally have run it once, since this function has no
 * way to know each job's own cadence, only its `maxAgeMs` ceiling.
 */
export function evaluateHeartbeats(
  docs: Partial<Record<HeartbeatJob, HeartbeatDocSnapshot>>,
  watchdog: WatchdogState,
  nowMs: number,
): HeartbeatFinding[] {
  const findings: HeartbeatFinding[] = [];
  const firstRunAtMs = toMillis(watchdog.firstRunAt);

  for (const job of Object.keys(JOB_HEARTBEAT_CONFIG) as HeartbeatJob[]) {
    const config = JOB_HEARTBEAT_CONFIG[job];
    const doc = docs[job];

    if (!doc) {
      // No heartbeat doc at all — only a `stale` candidate, gated by the
      // bootstrap window described above.
      if (firstRunAtMs > 0 && nowMs - firstRunAtMs > config.maxAgeMs) {
        findings.push({ job, reason: 'stale' });
      }
      continue;
    }

    const lastStartMs = toMillis(doc.lastStartAt);
    const lastOkMs = toMillis(doc.lastOkAt);
    const lastErrorMs = toMillis(doc.lastErrorAt);
    const lastFinishMs = Math.max(lastOkMs, lastErrorMs);

    // A run is currently in progress whenever the latest start is newer than
    // the latest finish (success or failure) — includes a job's very first
    // ever run, where lastOkMs/lastErrorMs/lastFinishMs are all 0 and only
    // lastStartAt exists. While that's true AND we're still within grace
    // (timeoutSeconds + 1h), emit no finding at all for this job: not
    // `unfinished` (grace hasn't elapsed — the run may still land cleanly),
    // and not `failed`/`stale` either, even if lastOkAt is missing or very
    // old, because a currently-running job gets a reprieve until it either
    // finishes or the grace window passes. This applies generally, not only
    // when lastOkMs is 0 — a weekly job with a week-old lastOkAt that has
    // just started its next run is exactly this case too, and reporting it
    // `stale` mid-run would be wrong. Once grace passes without a finish,
    // rule 1 below fires `unfinished` on a later check.
    const inProgress = lastStartMs > lastFinishMs;
    const graceMs = config.timeoutSeconds * 1000 + ONE_HOUR_MS;
    if (inProgress && nowMs - lastStartMs <= graceMs) {
      continue;
    }

    // Rule 1: unfinished — in progress, and grace has elapsed.
    if (inProgress) {
      findings.push({ job, reason: 'unfinished' });
      continue;
    }

    // Rule 2: failed — most recent event is an error with no later success.
    if (lastErrorMs > 0 && lastErrorMs > lastOkMs) {
      findings.push({ job, reason: 'failed' });
      continue;
    }

    // Rule 3: stale — lastOkAt missing or too old.
    if (lastOkMs === 0 || nowMs - lastOkMs > config.maxAgeMs) {
      findings.push({ job, reason: 'stale' });
    }
  }

  return findings;
}

/**
 * Filters `findings` down to ones not suppressed by the 24h dedupe window,
 * and returns the updated `lastAlertedAt` entries (only for findings that
 * passed the filter) for the caller to persist. Kept separate from
 * `evaluateHeartbeats` so that function's output always reflects the true,
 * undeduped state of the world — useful for tests and for the OK-line's
 * `findings=<n>` count, which reports on every dedupe-eligible finding, not
 * just the ones that made it past the 24h filter (that subset is the same
 * line's separate `logged=<n>` count, i.e. `toLog.length`).
 */
export function filterDeduped(
  findings: HeartbeatFinding[],
  lastAlertedAt: Record<string, number>,
  nowMs: number,
): { toLog: HeartbeatFinding[]; updates: Record<string, number> } {
  const toLog: HeartbeatFinding[] = [];
  const updates: Record<string, number> = {};

  for (const finding of findings) {
    const key = `${finding.job}:${finding.reason}`;
    const last = lastAlertedAt[key];
    if (last === undefined || nowMs - last > DEDUPE_WINDOW_MS) {
      toLog.push(finding);
      updates[key] = nowMs;
    }
  }

  return { toLog, updates };
}

async function readWatchdogState(db: Firestore): Promise<WatchdogState> {
  const snap = await db.doc(WATCHDOG_DOC_PATH).get();
  if (!snap.exists) return {};
  const data = snap.data() ?? {};
  return {
    firstRunAt: data.firstRunAt as Timestamp | undefined,
    lastAlertedAt: (data.lastAlertedAt as Record<string, number> | undefined) ?? {},
  };
}

async function readHeartbeatDocs(db: Firestore): Promise<Partial<Record<HeartbeatJob, HeartbeatDocSnapshot>>> {
  const jobs = Object.keys(JOB_HEARTBEAT_CONFIG) as HeartbeatJob[];
  const snaps = await Promise.all(jobs.map((job) => db.doc(`jobHeartbeats/${job}`).get()));
  const docs: Partial<Record<HeartbeatJob, HeartbeatDocSnapshot>> = {};
  jobs.forEach((job, i) => {
    const snap = snaps[i];
    if (!snap.exists) return;
    const data = snap.data() ?? {};
    docs[job] = {
      lastStartAt: data.lastStartAt as Timestamp | undefined,
      lastOkAt: data.lastOkAt as Timestamp | undefined,
      lastErrorAt: data.lastErrorAt as Timestamp | undefined,
    };
  });
  return docs;
}

/**
 * The watchdog itself — reads every job's `jobHeartbeats/{job}` doc plus
 * `jobHeartbeats/_watchdog`, evaluates them with `evaluateHeartbeats`,
 * dedupes with `filterDeduped`, logs `JOB_STALE_LOG_MARKER` for whatever
 * survives, and persists the updated dedupe/bootstrap state.
 *
 * Runs every 6 hours — deliberately far more often than the 23.5h ceiling
 * Cloud Monitoring imposes on a metric-ABSENCE policy (the kind that would
 * otherwise be the natural way to alarm on "this function stopped
 * running"): an absence policy watching this function's own
 * `JOB_HEARTBEAT_CHECK_OK_LOG_MARKER` line could not watch a weekly job at
 * all, since the policy itself would need to tolerate gaps longer than
 * 23.5h and Cloud Monitoring won't let it. Running the WATCHDOG frequently
 * sidesteps that limit entirely — it isn't the thing an absence policy
 * would need to watch across a multi-day gap, it's the thing that closes
 * the gap by checking in on every job, including weekly ones, several times
 * a day.
 *
 * Read-failure handling: if reading the heartbeat/`_watchdog` docs itself
 * throws, that error is rethrown unchanged and NO `JOB_HEARTBEAT_CHECK_OK`
 * line is logged — the function's own failure is then visible as a failed
 * scheduled execution / Cloud Functions error metric, which is a more
 * honest signal than a fabricated OK line would be.
 *
 * Write-failure handling: if evaluation succeeds but the state write
 * (dedupe timestamps + `firstRunAt`) fails, this function still logs every
 * `JOB_STALE` finding line from this check — they're true regardless of
 * whether the dedupe bookkeeping for NEXT time got persisted — but does NOT
 * log `JOB_HEARTBEAT_CHECK_OK`. This is deliberate: if the state write
 * failed, the dedupe window/bootstrap state going forward is not guaranteed
 * consistent (the next run might not have `lastAlertedAt` updated for a
 * finding just logged, and would log it again — an acceptable
 * over-alarm — or, in a scenario this code does not expect, could be
 * inconsistent in a way that under-alarms). Rather than claim a clean
 * "checked, all good" outcome while that uncertainty exists, the OK line is
 * simply withheld for this run.
 *
 * No claim/transaction against overlapping invocations: two concurrent runs
 * of this watchdog (e.g. a manual trigger landing mid-schedule) could both
 * read the same pre-dedupe state and each log the same JOB_STALE line —
 * accepted as a low-consequence duplicate, not worth the added complexity of
 * a lock for a 6-hourly job whose worst case is one extra log line.
 */
export async function runCheckJobHeartbeats(db: Firestore, nowMs: number = Date.now()): Promise<void> {
  const [docs, watchdog] = await Promise.all([readHeartbeatDocs(db), readWatchdogState(db)]);

  const findings = evaluateHeartbeats(docs, watchdog, nowMs);
  const { toLog, updates } = filterDeduped(findings, watchdog.lastAlertedAt ?? {}, nowMs);

  for (const finding of toLog) {
    logger.error(`${JOB_STALE_LOG_MARKER} job=${finding.job} reason=${finding.reason}`);
  }

  try {
    const statePatch: Record<string, unknown> = {};
    if (!watchdog.firstRunAt) {
      statePatch.firstRunAt = Timestamp.fromMillis(nowMs);
    }
    if (Object.keys(updates).length > 0) {
      // Firestore's `set(..., { merge: true })` merges nested MAP fields
      // key-by-key rather than replacing `lastAlertedAt` wholesale — so
      // writing just the keys that changed this run does not clobber
      // sibling keys from a previous run that this run didn't touch. See
      // this function's own docblock / the issue spec for why that had to
      // be verified rather than assumed, and
      // `__tests__/functions/checkJobHeartbeats.test.ts` for the test that
      // confirms it against the fake db used here.
      const lastAlertedAtPatch: Record<string, number> = {};
      for (const [key, value] of Object.entries(updates)) {
        lastAlertedAtPatch[key] = value;
      }
      statePatch.lastAlertedAt = lastAlertedAtPatch;
    }
    if (Object.keys(statePatch).length > 0) {
      await db.doc(WATCHDOG_DOC_PATH).set(statePatch, { merge: true });
    }
  } catch (err) {
    logger.warn('checkJobHeartbeats: watchdog state write failed — dedupe/bootstrap state may be stale next run', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const jobsChecked = Object.keys(JOB_HEARTBEAT_CONFIG).length;
  logger.info(
    `${JOB_HEARTBEAT_CHECK_OK_LOG_MARKER} checked=${jobsChecked} findings=${findings.length} logged=${toLog.length}`,
  );
}

export const checkJobHeartbeats = onSchedule(
  { schedule: 'every 6 hours', region: 'europe-west1' },
  async () => {
    await runCheckJobHeartbeats(getFirestore());
  },
);
