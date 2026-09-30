import { logger } from 'firebase-functions/v2';

/**
 * Filter marker for the Cloud Monitoring log-based alert policies (alpha,
 * beta and prod — issue #416) that fire when a GDPR retention purge job
 * can't fully do its job. Shared by three `onSchedule` wrappers in this
 * directory/its neighbor — `purgeOldFeedback.ts`, `purgeAuditLogs.ts` and
 * `../company/purgeLogs.ts` — each via `runWithRetentionAlert` below. The
 * policies match on
 * `textPayload:"RETENTION_PURGE_FAILED" OR jsonPayload.message:"RETENTION_PURGE_FAILED"`.
 *
 * Same reasoning as `lib/memberAnonymisationAlert.ts` and
 * `lib/accountDeletionAlert.ts`'s markers: the `textPayload` half is the
 * one that actually matches — a firebase-functions `logger.error(string)`
 * call whose only field is `message` is stored by Cloud Logging as
 * `textPayload`, not `jsonPayload`. The `jsonPayload.message` half only
 * matters if this marker is ever logged alongside object fields, which
 * `runWithRetentionAlert` deliberately never does — see its own docblock.
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
 * otherwise — tracked separately as issue #430.
 */
export async function runWithRetentionAlert<T>(
  job: string,
  run: () => Promise<T>,
  failedCount: (result: T) => number,
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
  if (failed > 0) {
    logger.error(`${RETENTION_PURGE_FAILED_LOG_MARKER} job=${job} failed=${failed}`);
  }

  return result;
}
