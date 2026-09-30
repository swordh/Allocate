import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { GrpcStatus, getFirestore, type Firestore } from 'firebase-admin/firestore';
import { runWithRetentionAlert, retentionDeadline } from './retentionPurgeAlert';
import { withJobHeartbeat, JOB_HEARTBEAT_CONFIG } from './jobHeartbeat';

/**
 * Options threaded through from the `onSchedule` wrapper — issue #435.
 * `deadlineExceeded` defaults to a predicate that never fires, so every
 * existing caller (emulator tests, `purgeOldFeedbackSweepFailures.test.ts`)
 * keeps its current unlimited-time behavior; only the real `onSchedule`
 * handler below passes a real one, built from `retentionDeadline` at handler
 * start — BEFORE `withJobHeartbeat`, so the budget also covers that wrapper's
 * own heartbeat writes.
 */
export interface PurgeOldFeedbackSweepOpts {
  deadlineExceeded?: () => boolean;
}

/**
 * GDPR Art. 5(1)(e) storage limitation: `operatorFeedback` tickets carry a
 * user's name, email and free-text description/notes with no retention
 * limit of their own (issue #338, carried over from #295's GDPR review of
 * #293). Anonymisation on account/membership deletion (PR 1 of this issue)
 * covers the identity FIELDS, but not the free text — someone who writes
 * "ring mig på 070-…" in a bug report keeps that in the ticket forever
 * unless the ticket itself eventually goes away. The decision made for this
 * issue: a ticket is deleted 24 months after it was CLOSED, not 24 months
 * after it was submitted — an open ticket is active support history and is
 * never purged by this job, however old, because it has no `closedAt` to
 * query against (see `CLOSED_FEEDBACK_STATUSES` / `closedAt` in
 * types/operator.ts and updateFeedbackStatus in
 * app/operator/(protected)/feedback/actions.ts, which is the only writer of
 * `closedAt`).
 *
 * `recursiveDelete`, not a query + chunked `WriteBatch`, because each
 * ticket owns a `notes` subcollection (the timeline of operator
 * notes/events — types/operator.ts's `FeedbackTimelineEntry`) that a plain
 * document delete would silently orphan. This mirrors
 * functions/src/company/purge.ts's `runSubtreePhase` reasoning: deletion
 * here is unconditional (every doc under a purged ticket is going, nothing
 * to individually judge), so re-deriving a tree walk by hand would just be
 * reimplementing what `recursiveDelete` already does. One BulkWriter shared
 * across every ticket in the sweep (not a fresh one per ticket), same as
 * that phase, and it must be closed here — `recursiveDelete` never closes a
 * BulkWriter handed to it.
 *
 * Exported as a plain function of `(db)`, matching
 * `purgeOldAuditLogsSweep`'s pattern in this same directory, so it can be
 * driven directly from an emulator test without going through the
 * `onSchedule` trigger.
 *
 * Two things a first version of this function got wrong, both fixed here
 * (code review, before this ever shipped):
 *
 *   - It reported `snap.size` as "purged" regardless of whether the deletes
 *     actually succeeded — a ticket whose `recursiveDelete` permanently
 *     failed (retries exhausted) would still be counted as gone. `purged`
 *     below is now the number of tickets this run actually confirmed
 *     deleted; `failed` is the number that permanently did not delete, each
 *     logged at `logger.error` (not `logger.warn` — a warn is reserved for
 *     an individual write that's still retrying).
 *   - It never re-checked a ticket's eligibility between the initial query
 *     and its actual deletion. An operator who reopens a ticket (or
 *     reclassifies it in a way that clears `closedAt`) in that window would
 *     otherwise still have it deleted out from under them, because the
 *     `snap` this function queried up front is a point-in-time read — it
 *     does not un-match a doc that changes afterward. Each ticket is now
 *     re-read immediately before its delete, and skipped (not counted as
 *     failed) if it no longer has a `closedAt` older than `cutoff`.
 *     RESIDUAL WINDOW: there is still a gap between that re-read and the
 *     `recursiveDelete` call itself — a reopen landing in exactly that
 *     single round trip would still be lost. Closing that fully would need
 *     a transaction per ticket (read `closedAt`, delete `notes` docs,
 *     delete the ticket doc, all inside one `runTransaction`), which is a
 *     meaningfully bigger change for a race window measured in
 *     milliseconds, once a week, against a ticket someone would have to be
 *     actively reopening at that exact instant. Accepted as-is; revisit if
 *     it's ever observed in practice.
 *
 * TWO more guards added for issue #435, both about a run that is going
 * badly rather than a single bad ticket:
 *
 *   - a time budget. `opts.deadlineExceeded` (built by the `onSchedule`
 *     wrapper from `retentionDeadline`, `./retentionPurgeAlert.ts`) is
 *     checked at the TOP of every loop iteration — before that ticket's
 *     re-read even starts. Once it trips, the loop stops immediately and
 *     every ticket from that point on (including the one that was about to
 *     be checked) is counted as `unfinished`, not `failed`: nothing about
 *     THEM went wrong, the sweep simply ran out of time. This is what lets
 *     the 540s timeout (issue #435, `./jobHeartbeat.ts`) resolve normally
 *     with an honest count instead of being SIGKILLed mid-ticket with no
 *     `unfinished` figure and no "sweep complete" log line at all.
 *   - a consecutive-failure circuit breaker. `consecutiveFailures` increments
 *     on EITHER catch branch below (a rejected re-read or a permanently
 *     failed `recursiveDelete`) and resets to zero on a successful delete OR
 *     a skipped (reopened/reclassified) ticket — a skip is not a failure and
 *     must not keep the counter primed. Five in a row stops the sweep the
 *     same way the time budget does (remaining tickets become `unfinished`,
 *     not individually retried), on the theory that five straight failures
 *     is not five unlucky tickets, it is Firestore itself in a bad state for
 *     this run, and burning the rest of the 540s hammering it produces
 *     nothing but more identical failures.
 *
 * Both guards leave `finally { bulkWriter.close() }` untouched — a budget or
 * circuit-breaker `break` out of the `for` loop still reaches it exactly
 * like a loop that runs to completion.
 *
 * Permanent per-ticket failures do NOT make this function throw. The sweep
 * is naturally self-healing: a ticket that this run could not confirm
 * eligible and deleted — either its pre-delete re-read rejected (issue
 * #433: that re-read is now counted in `failed` rather than thrown out of
 * the whole sweep), or the re-read succeeded but `recursiveDelete`
 * permanently failed — is simply still sitting in Firestore afterward,
 * still matches `closedAt < cutoff`, and gets tried again next Monday with
 * no operator action needed — unlike `purgeOldAuditLogsSweep` in this same
 * directory, which propagates a throwing `batch.commit()` straight out (it
 * has no per-row failure path to swallow into). Throwing here instead would
 * mark the ENTIRE weekly run as failed over what is very likely a handful
 * of transient documents out of a much larger batch, inviting Cloud
 * Scheduler retries that redo the whole query-and-delete pass for no
 * benefit (everything already deleted is already gone; redoing it is a
 * cheap no-op, but the noise is not). `failed > 0` is logged at
 * `logger.error` so the outcome is visible to anyone reading Cloud Logging
 * for this function, and also feeds the `RETENTION_PURGE_FAILED` alert
 * marker (issue #416, `./retentionPurgeAlert.ts`) via the `onSchedule`
 * wrapper below (through the exported `purgeOldFeedbackFailedCount`),
 * alongside `closeFailed` — together with `ACCOUNT_DELETION_STUCK`
 * (`lib/accountDeletionAlert.ts`) and `MEMBER_ANONYMISATION_STUCK`
 * (`lib/memberAnonymisationAlert.ts`, issue #419), that marker is the third
 * of this project's log-based alert policies, not something this function
 * defines itself. The shared BulkWriter must be closed no matter how the
 * per-ticket loop ends, so the loop runs inside a `try` whose `finally`
 * always reaches `bulkWriter.close()`.
 */
/** Consecutive per-ticket failures the circuit breaker allows before aborting the rest of the run. See docblock above. */
const MAX_CONSECUTIVE_FAILURES = 5;

export async function purgeOldFeedbackSweep(
  db: Firestore,
  opts: PurgeOldFeedbackSweepOpts = {},
): Promise<{ purged: number; failed: number; closeFailed: boolean; unfinished: number }> {
  const deadlineExceeded = opts.deadlineExceeded ?? (() => false);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 24);

  const snap = await db.collection('operatorFeedback').where('closedAt', '<', cutoff).get();
  if (snap.empty) return { purged: 0, failed: 0, closeFailed: false, unfinished: 0 };

  const bulkWriter = db.bulkWriter();
  // Same policy as `runSubtreePhase` (functions/src/company/purge.ts):
  // returns exactly the publicly documented default retry policy
  // (`BulkWriter.onWriteError`'s own doc comment: "retries UNAVAILABLE and
  // ABORTED errors up to a maximum of 10 failed attempts") — setting a
  // handler at all REPLACES BulkWriter's internal default outright, so
  // logging here would otherwise silently also change what gets retried.
  // Only the FINAL, no-longer-retried failure is logged at `error` level;
  // every retry attempt in between logs at `warn` — see the two-argument
  // `log` call below.
  const MAX_DELETE_RETRY_ATTEMPTS = 10;
  bulkWriter.onWriteError((error) => {
    const shouldRetry =
      (error.code === GrpcStatus.UNAVAILABLE || error.code === GrpcStatus.ABORTED) &&
      error.failedAttempts < MAX_DELETE_RETRY_ATTEMPTS;
    const log = shouldRetry ? logger.warn : logger.error;
    log('purgeOldFeedback: delete failed', {
      path: error.documentRef.path,
      code: error.code,
      failedAttempts: error.failedAttempts,
      willRetry: shouldRetry,
    });
    return shouldRetry;
  });

  let purged = 0;
  let failed = 0;
  let skippedReopened = 0;
  let unfinished = 0;
  let consecutiveFailures = 0;
  const cutoffMillis = cutoff.getTime();
  let closeFailed = false;

  try {
    for (let index = 0; index < snap.docs.length; index++) {
      // Time-budget check — issue #435. Checked at the TOP of every
      // iteration, before this ticket's re-read even starts, so a trip here
      // never leaves a ticket half-processed. Everything from `index` on
      // (this ticket included) is `unfinished`, not `failed` — the run is
      // simply out of time, not broken. See the docblock above.
      if (deadlineExceeded()) {
        unfinished = snap.docs.length - index;
        logger.info('purgeOldFeedback: time budget exceeded, stopping early', {
          purged,
          failed,
          unfinished,
        });
        break;
      }

      const doc = snap.docs[index];

      // Reopen-race guard — see the docblock above. Read the ticket's
      // CURRENT state, not the one captured in `snap` above, immediately
      // before deleting it. This re-read gets its own try/catch (issue
      // #433) so a transient read failure is counted in `failed` and
      // logged with a distinct message, instead of throwing out of the
      // whole sweep and skipping every ticket after it.
      let fresh;
      try {
        fresh = await doc.ref.get();
      } catch (err) {
        failed++;
        consecutiveFailures++;
        logger.error('purgeOldFeedback: ticket re-read failed', {
          path: doc.ref.path,
          error: err instanceof Error ? err.message : String(err),
        });
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          unfinished = snap.docs.length - index - 1;
          logger.error('purgeOldFeedback: aborting after 5 consecutive failures', {
            purged,
            failed,
            unfinished,
          });
          break;
        }
        continue;
      }

      if (!fresh.exists || !isStillEligibleForPurge(fresh.data()?.closedAt, cutoffMillis)) {
        skippedReopened++;
        consecutiveFailures = 0;
        continue;
      }

      try {
        await db.recursiveDelete(doc.ref, bulkWriter);
        purged++;
        consecutiveFailures = 0;
      } catch (err) {
        failed++;
        consecutiveFailures++;
        logger.error('purgeOldFeedback: ticket purge failed permanently', {
          path: doc.ref.path,
          error: err instanceof Error ? err.message : String(err),
        });
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          unfinished = snap.docs.length - index - 1;
          logger.error('purgeOldFeedback: aborting after 5 consecutive failures', {
            purged,
            failed,
            unfinished,
          });
          break;
        }
      }
    }
  } finally {
    // Runs whether the loop above completed normally or something inside
    // it threw past the per-ticket try/catches — the BulkWriter must be
    // closed no matter what (see docblock).
    try {
      await bulkWriter.close();
    } catch (err) {
      // `recursiveDelete`'s own per-ticket rejection above already reflects
      // every permanent per-document failure this BulkWriter produces — see
      // its doc comment: "the promise is rejected if any of the deletes
      // fail." A rejection surfacing HERE instead would mean something failed
      // outside that accounting (e.g. after the last per-ticket call
      // returned but before the writer's internal queue fully drained).
      // Logged, and reflected in `closeFailed` (not folded into `failed`
      // itself), precisely because it can't be attributed to a specific
      // ticket the way the per-ticket catch above can — the `onSchedule`
      // wrapper below folds it into the retention alert's failure count.
      closeFailed = true;
      logger.error('purgeOldFeedback: bulkWriter close reported an additional failure', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (skippedReopened > 0) {
    logger.info('purgeOldFeedback: skipped tickets no longer eligible (reopened/reclassified since the query ran)', {
      skippedReopened,
    });
  }

  return { purged, failed, closeFailed, unfinished };
}

/**
 * True if `closedAt` (as freshly re-read, not the value the initial sweep
 * query matched on) is still a real Timestamp older than `cutoffMillis`.
 * Exported as its own pure function so the reopen-race guard is unit
 * testable without a Firestore connection — see
 * `__tests__/functions/purgeOldFeedbackReopenGuard.test.ts`.
 */
export function isStillEligibleForPurge(closedAt: unknown, cutoffMillis: number): boolean {
  if (!closedAt || typeof (closedAt as { toMillis?: unknown }).toMillis !== 'function') return false;
  return (closedAt as { toMillis: () => number }).toMillis() < cutoffMillis;
}

/**
 * Failure count fed to `runWithRetentionAlert` for the `RETENTION_PURGE_FAILED`
 * marker — `failed` (per-ticket re-read/delete failures) plus one more if
 * the shared BulkWriter itself reported a close failure it couldn't
 * attribute to a specific ticket (see the sweep's docblock).
 */
export function purgeOldFeedbackFailedCount(r: { failed: number; closeFailed: boolean }): number {
  return r.failed + (r.closeFailed ? 1 : 0);
}

/**
 * `unfinished` count fed to `runWithRetentionAlert` (issue #435) — a
 * separate function from `purgeOldFeedbackFailedCount` because the two are
 * genuinely different signals: `failed` is rows this run tried and could not
 * purge, `unfinished` is rows this run never got to at all (time budget or
 * circuit breaker), passed straight through from the sweep's own result.
 */
export function purgeOldFeedbackUnfinishedCount(r: { unfinished: number }): number {
  return r.unfinished;
}

export const purgeOldFeedback = onSchedule(
  {
    schedule: 'every monday 03:30',
    region: 'europe-west1',
    // Sourced from JOB_HEARTBEAT_CONFIG, not a literal — this IS the deployed
    // Cloud Run timeout, not just a value the watchdog reads (see
    // jobHeartbeat.ts's docblock). Changing it here changes this function's
    // real timeout on next deploy.
    timeoutSeconds: JOB_HEARTBEAT_CONFIG.purgeOldFeedback.timeoutSeconds,
  },
  async () => {
    // Deadline created at handler start, BEFORE `withJobHeartbeat` — issue
    // #435. The budget has to cover the heartbeat wrapper's own write too,
    // not just the sweep body, or a slow heartbeat write right at the end
    // could still push the whole invocation past the real timeout.
    const deadlineExceeded = retentionDeadline('purgeOldFeedback');

    // `withJobHeartbeat` wraps the whole handler, outermost — issue #430.
    // See `purgeOldAuditLogs.ts`'s matching comment for why.
    await withJobHeartbeat(getFirestore(), 'purgeOldFeedback', async () => {
      const { purged, failed, closeFailed, unfinished } = await runWithRetentionAlert(
        'purgeOldFeedback',
        () => purgeOldFeedbackSweep(getFirestore(), { deadlineExceeded }),
        purgeOldFeedbackFailedCount,
        purgeOldFeedbackUnfinishedCount,
      );
      logger.info('purgeOldFeedback: sweep complete', { purged, failed, closeFailed, unfinished });
    });
  }
);
