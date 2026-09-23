import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

const BATCH_LIMIT = 490;

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
 */
export async function purgeOldAuditLogsSweep(db: Firestore): Promise<{ purged: number }> {
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

  if (refs.size === 0) return { purged: 0 };

  // Chunked — a company with many stranded members, or simply a year of
  // self-service deletions, can push this well past Firestore's 500-write
  // batch limit. The original version of this function committed everything
  // in one unchunked batch; see the plan's own note calling that out as the
  // pattern NOT to copy elsewhere in this codebase.
  let batch = db.batch();
  let opCount = 0;
  for (const ref of refs.values()) {
    batch.delete(ref);
    opCount++;
    if (opCount >= BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      opCount = 0;
    }
  }
  if (opCount > 0) await batch.commit();

  return { purged: refs.size };
}

// GDPR Art. 5(1)(e) storage limitation: purge deletion audit log entries older
// than 12 months. The log stores only a sha256 hash of the uid — no PII — but
// retention beyond the audit period has no legal basis.
export const purgeOldAuditLogs = onSchedule(
  { schedule: 'every monday 03:00', region: 'europe-west1' },
  async () => {
    const { purged } = await purgeOldAuditLogsSweep(getFirestore());
    // The original version of this function logged nothing at all, which is
    // half of why its unchunked-batch bug went unnoticed for so long: a
    // retention job that says nothing is indistinguishable from one that
    // never ran.
    logger.info('purgeOldAuditLogs: sweep complete', { purged });
  }
);
