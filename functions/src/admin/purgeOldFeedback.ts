import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { GrpcStatus, getFirestore, type Firestore } from 'firebase-admin/firestore';

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
 */
export async function purgeOldFeedbackSweep(db: Firestore): Promise<{ purged: number }> {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 24);

  const snap = await db.collection('operatorFeedback').where('closedAt', '<', cutoff).get();
  if (snap.empty) return { purged: 0 };

  const bulkWriter = db.bulkWriter();
  // Same policy as `runSubtreePhase` (functions/src/company/purge.ts):
  // returns exactly the publicly documented default retry policy
  // (`BulkWriter.onWriteError`'s own doc comment: "retries UNAVAILABLE and
  // ABORTED errors up to a maximum of 10 failed attempts") — setting a
  // handler at all REPLACES BulkWriter's internal default outright, so
  // logging here would otherwise silently also change what gets retried.
  const MAX_DELETE_RETRY_ATTEMPTS = 10;
  bulkWriter.onWriteError((error) => {
    const shouldRetry =
      (error.code === GrpcStatus.UNAVAILABLE || error.code === GrpcStatus.ABORTED) &&
      error.failedAttempts < MAX_DELETE_RETRY_ATTEMPTS;
    logger.warn('purgeOldFeedback: delete failed', {
      path: error.documentRef.path,
      code: error.code,
      failedAttempts: error.failedAttempts,
      willRetry: shouldRetry,
    });
    return shouldRetry;
  });

  for (const doc of snap.docs) {
    await db.recursiveDelete(doc.ref, bulkWriter);
  }
  await bulkWriter.close();

  return { purged: snap.size };
}

export const purgeOldFeedback = onSchedule(
  { schedule: 'every monday 03:30', region: 'europe-west1' },
  async () => {
    const { purged } = await purgeOldFeedbackSweep(getFirestore());
    logger.info('purgeOldFeedback: sweep complete', { purged });
  }
);
