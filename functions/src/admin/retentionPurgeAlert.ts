import { logger } from 'firebase-functions/v2';
import { JOB_HEARTBEAT_CONFIG } from './jobHeartbeat';

/**
 * Filter marker for the Cloud Monitoring log-based alert policies (alpha,
 * beta and prod — issue #416) that fire when a GDPR retention purge job
 * can't fully do its job. Shared by three `onSchedule` wrappers in this
 * directory/its neighbor — `purgeOldFeedback.ts`, `purgeAuditLogs.ts` and
 * `../company/purgeLogs.ts` — each via `runWithRetentionAlert` below. The
 * policies match on
 * `resource.type="cloud_run_revision" AND textPayload:"RETENTION_PURGE_FAILED"`.
 *
 * VERIFIED on alpha 2026-09-30: a plain-string `logger.error()` call from
 * `firebase-functions/v2`'s `logger`, in these Cloud Run (gen2) functions,
 * lands in `textPayload`, not `jsonPayload` — confirmed by triggering a real
 * `JOB_STALE` finding from `checkJobHeartbeats` (same logger path, same
 * runtime) and reading the raw entry in Cloud Logging. A `logger.error` call
 * arrives as `Error: <message>` followed by the stack trace, all as ONE log
 * entry (not split per line) on `run.googleapis.com/stderr`; the `:`
 * substring operator still matches that, but the filter must not anchor the
 * marker to the start of the line — the message is prefixed with `Error: `,
 * not bare. The alpha policy (one per environment, covering all three
 * jobs) was narrowed to the `textPayload`-only filter above; the beta and
 * prod policies are created with this narrowed filter at promotion.
 *
 * Keep the log a plain string, and don't rename this constant or change its
 * value without updating all three alert policies (alpha, beta, prod) —
 * either one silently breaks the alert with no local signal anything is
 * wrong.
 *
 * Lives in `functions/src/admin/` rather than root `lib/` (where the two
 * markers referenced above live): Cloud Functions cannot import from root
 * `lib/` without breaking the App Hosting build's typecheck — see
 * `project_apphosting_typecheck_grans` — and all three jobs this marker
 * covers are Cloud Functions, not Next.js code, so there is no
 * `'use server'` constraint pulling it out of its own module either.
 */
export const RETENTION_PURGE_FAILED_LOG_MARKER = 'RETENTION_PURGE_FAILED';

/**
 * The only three jobs allowed to feed `runWithRetentionAlert`'s `job`
 * parameter. A union rather than `string` on purpose: the marker line is
 * grepped/read by a human in Cloud Logging, not machine-parsed, so a typo'd
 * or renamed job label would silently stop matching whatever someone
 * expects to see there with no compiler error to catch it. Add a job here
 * when a fourth retention sweep needs the same alert.
 */
export type RetentionPurgeJob = 'purgeOldFeedback' | 'purgeOldAuditLogs' | 'purgeCompanyDeletionLogs';

/**
 * Seconds of headroom `retentionDeadline` reserves before a sweep's real
 * `onSchedule` `timeoutSeconds` (`./jobHeartbeat.ts`'s `JOB_HEARTBEAT_CONFIG`
 * — issue #435). The platform SIGKILLs a Cloud Run function the instant its
 * timeout elapses, mid-write if that's where it happens to be — no chance to
 * finish the write in flight, close a `BulkWriter`, or log anything at all.
 * A budget that only fired AT the timeout would just move the same cliff a
 * few statements later; the margin exists so the sweep can notice it's out
 * of time, stop looping, and still get its "complete" log line and its
 * `unfinished` count out the door before the platform pulls the plug. 60s is
 * generous for the slowest single unit of work any of the three sweeps does
 * (one `batch.commit()`, one `recursiveDelete()` on a ticket, one redaction
 * chunk) — see each sweep's own deadline check for why that unit, not
 * anything smaller, is what has to fit inside the margin.
 */
export const RETENTION_BUDGET_MARGIN_SECONDS = 60;

/**
 * Builds a `deadlineExceeded` predicate for a sweep's `opts` (see
 * `purgeOldFeedback.ts`, `purgeAuditLogs.ts` and `../company/purgeLogs.ts`,
 * issue #435): a closure that turns true once the sweep has been running
 * for `JOB_HEARTBEAT_CONFIG[job].timeoutSeconds - RETENTION_BUDGET_MARGIN_SECONDS`
 * seconds, measured from `startMs`.
 *
 * `startMs` and `nowFn` are both parameters, not `Date.now()` baked in
 * directly, purely so tests can move the clock without a fake timer: a test
 * passes a fixed `startMs` and a `nowFn` that returns whatever instant it
 * wants to assert the boundary at. Production callers pass neither and get
 * a real wall-clock deadline anchored to the moment the `onSchedule` handler
 * started running (created BEFORE `withJobHeartbeat`, per each wrapper's own
 * comment, so the budget covers the heartbeat's own write too).
 *
 * Deliberately reads `JOB_HEARTBEAT_CONFIG` — the same source of truth
 * `./jobHeartbeat.ts` uses for the actual deployed `timeoutSeconds` — rather
 * than taking a duration directly, so the budget can never silently drift
 * from the real timeout the way two independently-maintained numbers could.
 * `jobHeartbeat.ts` only takes a TYPE from this module (`RetentionPurgeJob`,
 * via `import type`), which TypeScript elides at compile time — this value
 * import running the other direction does not create a runtime circular
 * dependency between the two compiled modules.
 */
export function retentionDeadline(
  job: RetentionPurgeJob,
  startMs: number = Date.now(),
  nowFn: () => number = Date.now,
): () => boolean {
  const budgetMs = (JOB_HEARTBEAT_CONFIG[job].timeoutSeconds - RETENTION_BUDGET_MARGIN_SECONDS) * 1000;
  const deadlineMs = startMs + budgetMs;
  return () => nowFn() >= deadlineMs;
}

/**
 * Runs a retention sweep and logs `RETENTION_PURGE_FAILED_LOG_MARKER`
 * exactly once, as a plain single-line string, whenever that sweep didn't
 * fully succeed — either because it reports a nonzero failure count, or
 * because it threw outright. Shared by `purgeOldFeedback`,
 * `purgeOldAuditLogs` and `purgeCompanyDeletionLogs`'s `onSchedule`
 * wrappers so the three jobs read off one alerting path rather than three
 * copies of the same "should this fire" logic.
 *
 * `failedCount` is a function of the resolved result, not a field name,
 * because the three jobs don't agree on what "failed" means: feedback also
 * needs to fold in a `bulkWriter.close()` failure that isn't part of its
 * per-ticket `failed` count, audit logs currently have no per-row failure
 * signal at all (their sweep either completes or throws), and company
 * deletion logs already has its own `failedRows`. See each `onSchedule`
 * wrapper for how it plugs in.
 *
 * On the throw path, the error message is collapsed to a single line
 * (all whitespace/newlines folded to single spaces) and truncated to ~300
 * characters before being logged — a multi-line or very long message would
 * otherwise either split across multiple Cloud Logging entries (defeating
 * the single-line marker match above) or bloat the log. The ORIGINAL error
 * is always rethrown unchanged after logging, so callers see exactly what
 * they would have without this wrapper.
 *
 * No PII in the marker line by construction: only the job name and a
 * count (or a Firestore/driver error message, which in this codebase's
 * experience carries operational detail — timeouts, codes, doc paths at
 * most — not user data) ever appear in it. Callers must not pass a
 * `failedCount` or error path that embeds a document id, email or name
 * into the logged line.
 *
 * NOT covered: a run that never happens at all (Cloud Scheduler itself
 * failing to invoke the function, or the function being deleted/misconfig-
 * ured) produces no log line for this helper to catch, successful or
 * otherwise — that gap is closed separately, by the heartbeat mechanism in
 * `./jobHeartbeat.ts` and the watchdog in `./checkJobHeartbeats.ts` (issue
 * #430), which alarms from a job's own start/ok/error timestamps rather
 * than from anything this helper logs.
 *
 * `unfinishedCount` (issue #435) is the fourth, OPTIONAL parameter: a
 * sweep's own time budget (`retentionDeadline` above) can stop it cleanly
 * before the platform's real timeout, leaving some rows untouched but still
 * resolving normally rather than throwing — that outcome is neither a
 * per-row failure nor a crash, so it needed its own signal rather than being
 * folded into `failedCount`. When a caller passes it and the resolved
 * `unfinishedCount(result)` is greater than zero, the marker line gains a
 * trailing ` unfinished=M` — appended ONLY when M > 0, so the line's format
 * is byte-for-byte unchanged for every caller that omits this parameter or
 * whose sweep always finishes within budget (existing tests assert the exact
 * string and must keep passing). The marker now fires on `failed > 0 ||
 * unfinished > 0` — a budget cutoff with zero per-row failures still has to
 * be visible, because rows were left un-purged past their retention deadline
 * with nothing else that would report it.
 */
export async function runWithRetentionAlert<T>(
  job: RetentionPurgeJob,
  run: () => Promise<T>,
  failedCount: (result: T) => number,
  unfinishedCount?: (result: T) => number,
): Promise<T> {
  let result: T;
  try {
    result = await run();
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const collapsed = rawMessage.replace(/\s+/g, ' ').trim();
    const truncated = collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed;
    logger.error(`${RETENTION_PURGE_FAILED_LOG_MARKER} job=${job} error=${truncated}`);
    throw err;
  }

  const failed = failedCount(result);
  const unfinished = unfinishedCount ? unfinishedCount(result) : 0;
  if (failed > 0 || unfinished > 0) {
    const suffix = unfinished > 0 ? ` unfinished=${unfinished}` : '';
    logger.error(`${RETENTION_PURGE_FAILED_LOG_MARKER} job=${job} failed=${failed}${suffix}`);
  }

  return result;
}
