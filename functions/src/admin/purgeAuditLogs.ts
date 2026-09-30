import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { runWithRetentionAlert, retentionDeadline } from './retentionPurgeAlert';
import { withJobHeartbeat, JOB_HEARTBEAT_CONFIG } from './jobHeartbeat';

const BATCH_LIMIT = 490;

/**
 * Options threaded through from the `onSchedule` wrapper — issue #435, same
 * shape and same default (never exceeded) as `purgeOldFeedback.ts`'s
 * `PurgeOldFeedbackSweepOpts`, so every existing caller of this sweep is
 * unaffected.
 */
export interface PurgeOldAuditLogsSweepOpts {
  deadlineExceeded?: () => boolean;
}

/**
 * `deletionAuditLog` carries four shapes, all governed by the same
 * 12-month GDPR Art. 5(1)(e) storage-limitation rule, on four different
 * field names. The `triggeredBy` values named below (all but `'user_self'`)
 * are exported as constants from `functions/src/deletionAuditLogTriggers.ts`
 * — quoted here as literals only for readability of this comment, not
 * because this function ever compares against one; it never reads
 * `triggeredBy` at all, only the timestamp field name each shape carries:
 *
 *   - self-service account deletion (`actions/account.ts`, `triggeredBy:
 *     'user_self'`) and the stranded-account enforcement sweep's own
 *     deletion branch (`functions/src/company/strandedAccountSweep.ts`,
 *     `triggeredBy: 'stranded_account_sweep_enforced'`, issue #252 step 6)
 *     both carry `deletedAt` — something was actually deleted when the row
 *     was written.
 *   - a stranded member's account-deletion SCHEDULE
 *     (`functions/src/company/memberCleanup.ts`, `triggeredBy:
 *     'company_deletion_stranded_member'`, issue #252 step 5) carries
 *     `scheduledAt` instead. Nothing was deleted when THIS row was
 *     written — only scheduled — so it deliberately does NOT also carry a
 *     `deletedAt`; writing one would misrepresent the event.
 *   - that same sweep's SPARE branch (`functions/src/company/
 *     strandedAccountSweep.ts`, `triggeredBy:
 *     'stranded_account_sweep_spared_membership_found'`, issue #252 step 6)
 *     carries `clearedAt` instead of either — the schedule was cancelled,
 *     not fulfilled and not freshly created, and neither existing field name
 *     would honestly describe that.
 *   - a FAILED self-service deletion attempt (`actions/account.ts`'s
 *     `writeDeletionFailureAudit`, `triggeredBy: 'user_self'`, issue #358)
 *     carries `failedAt` instead of `deletedAt` — nothing was deleted (or
 *     only partially was) when this row was written, so reusing `deletedAt`
 *     would claim a success that didn't happen. It also carries
 *     `outcome: 'failed'`, `failedStep`, `errorCode`, `completedCompanies`
 *     and `totalCompanies`, none of which any other shape has — this is the
 *     only shape that records a FAILURE rather than an action taken.
 *
 * Querying only `deletedAt` (as this function used to, before `scheduledAt`
 * was added) means every scheduling row is invisible to this purge
 * forever — no error, no empty result, just permanently un-matched — which
 * is retention with no legal basis for exactly the rows meant to be covered
 * by it. The same failure mode applies to any field this function doesn't
 * query, which is why `clearedAt` and now `failedAt` join the others here
 * rather than living as a silently-immortal row shape. Query all four
 * fields.
 *
 * Exported as a plain function of `(db)` for the same reason every other
 * function in this file's neighborhood is — see `runCompanyPurge`'s
 * docblock in functions/src/company/purge.ts for the pattern this matches.
 *
 * `opts.deadlineExceeded` (issue #435, `./retentionPurgeAlert.ts`'s
 * `retentionDeadline`) is checked before every `batch.commit()`, not after —
 * a chunk that has not been committed yet has not deleted anything, so
 * there is nothing to "roll back": the deadline check simply drops that
 * uncommitted batch on the floor and stops. `purged` is the number of rows
 * from chunks that ACTUALLY committed (not `refs.size`, which would count
 * rows this run never got to write), and `unfinished` is everything left in
 * `refs` that no committed chunk covered. This mirrors
 * `purgeOldFeedback.ts`'s time budget in spirit but not in mechanics — that
 * sweep can stop between two already-independent per-ticket operations,
 * this one stops between two independent CHUNKS, since a single chunk's
 * `batch.commit()` is itself all-or-nothing and can't be interrupted
 * partway through.
 */
export async function purgeOldAuditLogsSweep(
  db: Firestore,
  opts: PurgeOldAuditLogsSweepOpts = {},
): Promise<{ purged: number; unfinished: number }> {
  const deadlineExceeded = opts.deadlineExceeded ?? (() => false);
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);

  const [byDeletedAt, byScheduledAt, byClearedAt, byFailedAt] = await Promise.all([
    db.collection('deletionAuditLog').where('deletedAt', '<', cutoff).get(),
    db.collection('deletionAuditLog').where('scheduledAt', '<', cutoff).get(),
    db.collection('deletionAuditLog').where('clearedAt', '<', cutoff).get(),
    db.collection('deletionAuditLog').where('failedAt', '<', cutoff).get(),
  ]);

  // De-duplicated by doc id — the four queries are mutually exclusive by
  // construction (a row carries exactly one of the four fields, never more
  // than one), but a Map keyed by id costs nothing and removes any need to
  // trust that stays true forever.
  const refs = new Map<string, FirebaseFirestore.DocumentReference>();
  for (const doc of byDeletedAt.docs) refs.set(doc.id, doc.ref);
  for (const doc of byScheduledAt.docs) refs.set(doc.id, doc.ref);
  for (const doc of byClearedAt.docs) refs.set(doc.id, doc.ref);
  for (const doc of byFailedAt.docs) refs.set(doc.id, doc.ref);

  if (refs.size === 0) return { purged: 0, unfinished: 0 };

  // Chunked — a company with many stranded members, or simply a year of
  // self-service deletions, can push this well past Firestore's 500-write
  // batch limit. The original version of this function committed everything
  // in one unchunked batch; see the plan's own note calling that out as the
  // pattern NOT to copy elsewhere in this codebase.
  const allRefs = Array.from(refs.values());
  let purged = 0;
  let index = 0;
  while (index < allRefs.length) {
    if (deadlineExceeded()) {
      const unfinished = allRefs.length - index;
      logger.info('purgeOldAuditLogs: time budget exceeded, stopping before next chunk', {
        purged,
        unfinished,
      });
      return { purged, unfinished };
    }

    const chunk = allRefs.slice(index, index + BATCH_LIMIT);
    const batch = db.batch();
    for (const ref of chunk) batch.delete(ref);
    await batch.commit();
    purged += chunk.length;
    index += chunk.length;
  }

  return { purged, unfinished: 0 };
}

// GDPR Art. 5(1)(e) storage limitation: purge deletion audit log entries older
// than 12 months. The log stores only an HMAC-keyed hash of the uid (issue
// #294 — see functions/src/audit/userIdHash.ts's docblock for why a plain
// unkeyed hash was not pseudonymisation) — still personal data, not
// anonymous, since anyone holding the key can link a row back to a person —
// so retention beyond the audit period still has no legal basis.
export const purgeOldAuditLogs = onSchedule(
  {
    schedule: 'every monday 03:00',
    region: 'europe-west1',
    // Sourced from JOB_HEARTBEAT_CONFIG, not a literal — this IS the deployed
    // Cloud Run timeout, not just a value the watchdog reads (see
    // jobHeartbeat.ts's docblock). Changing it here changes this function's
    // real timeout on next deploy.
    timeoutSeconds: JOB_HEARTBEAT_CONFIG.purgeOldAuditLogs.timeoutSeconds,
  },
  async () => {
    // Deadline created at handler start, BEFORE `withJobHeartbeat` — issue
    // #435, same reasoning as `purgeOldFeedback.ts`'s wrapper: the budget has
    // to cover the heartbeat write too, not just the sweep body.
    const deadlineExceeded = retentionDeadline('purgeOldAuditLogs');

    // `withJobHeartbeat` wraps the whole handler body, outermost — issue
    // #430. It writes `jobHeartbeats/purgeOldAuditLogs` around the run so
    // the watchdog in `./checkJobHeartbeats.ts` can notice this job never
    // starting, never finishing, or repeatedly erroring, independent of
    // whether `runWithRetentionAlert` below ever gets a chance to log
    // anything.
    await withJobHeartbeat(getFirestore(), 'purgeOldAuditLogs', async () => {
      // This sweep has no per-row failure count of its own — it either
      // completes or a `batch.commit()` throws and the whole execution fails
      // (see the sweep's own docblock on why nothing here catches that). So
      // `failedCount` is always 0: only the throw path can ever feed the
      // `RETENTION_PURGE_FAILED` alert marker (issue #416,
      // `./retentionPurgeAlert.ts`) for this job. `unfinishedCount` (issue
      // #435) is new: a time-budget stop now resolves normally instead of
      // throwing, so it needs its own path into that same marker.
      const { purged, unfinished } = await runWithRetentionAlert(
        'purgeOldAuditLogs',
        () => purgeOldAuditLogsSweep(getFirestore(), { deadlineExceeded }),
        () => 0,
        (r) => r.unfinished,
      );
      // The original version of this function logged nothing at all, which is
      // half of why its unchunked-batch bug went unnoticed for so long: a
      // retention job that says nothing is indistinguishable from one that
      // never ran.
      logger.info('purgeOldAuditLogs: sweep complete', { purged, unfinished });
    });
  }
);
