import { Timestamp, getFirestore, type Firestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';

/** Sized for PR G's chunked redaction writes — see the TODO below. */
export const BATCH_LIMIT = 490;

export interface PurgeCompanyDeletionLogsResult {
  eligible: number;
}

/**
 * SKELETON — the plan (PR G) is what sharpens this into the real
 * 24-month retention job. This PR (E) only wires up the scheduled function
 * and its query so PR G has something to attach the actual redaction to,
 * and so the collection is queried at all before then.
 *
 * What PR G adds: for every `companyDeletions/{id}` older than
 * `purgeAfter` with no `identityRedactedAt` yet, BLANK `requestedByUid`,
 * `requestedByName`, `requestedByEmail` (and the `canceled*` identity
 * equivalents, where present) and set `identityRedactedAt` — never delete
 * the row itself. See the GDPR/Art. 17(3)(e) doc comment on
 * `CompanyDeletionRecord` in types/company.ts: the event has to survive for
 * the operator history (step 6), only the identity behind it doesn't.
 *
 * Deliberately querying and chunking correctly from the start, even though
 * this skeleton does no writes yet: `functions/src/admin/purgeAuditLogs.ts`
 * is the cautionary tale the plan calls out by name — it commits everything
 * in ONE `batch.commit()` with no chunking, which throws outright past 500
 * documents and logs nothing when it does. Don't copy that shape into PR
 * G's version of this function; the `BATCH_LIMIT`-chunked pattern is
 * already here, ready for that phase's `batch.update(...)` calls.
 */
export async function purgeCompanyDeletionLogsSweep(db: Firestore): Promise<PurgeCompanyDeletionLogsResult> {
  const now = Timestamp.now();
  // Firestore has no "field is absent" query, and `identityRedactedAt` is
  // absent (not null) on every row that hasn't been redacted yet — querying
  // `== null` here would silently match nothing, forever. Query on
  // `purgeAfter` only (the index's leading field) and filter the already-
  // redacted rows out in code instead.
  const candidatesSnap = await db.collection('companyDeletions').where('purgeAfter', '<=', now).get();
  const eligibleDocs = candidatesSnap.docs.filter((doc) => !doc.data()['identityRedactedAt']);

  // TODO(PR G): chunk `eligibleDocs` at BATCH_LIMIT and, per doc,
  // batch.update(doc.ref, { requestedByUid: null, requestedByName: null,
  //   requestedByEmail: null, canceledByUid: null, canceledByName: null,
  //   canceledByEmail: null, identityRedactedAt: now }) — BATCH_LIMIT above
  // is already sized for that chunking; don't repeat purgeAuditLogs.ts's
  // single-unchunked-batch.commit() mistake when this is filled in.

  logger.info('purgeCompanyDeletionLogsSweep: eligible rows found, redaction not yet implemented (PR G)', {
    eligible: eligibleDocs.length,
  });

  return { eligible: eligibleDocs.length };
}

export const purgeCompanyDeletionLogs = onSchedule(
  { schedule: 'every monday 04:00', region: 'europe-west1' },
  async () => {
    await purgeCompanyDeletionLogsSweep(getFirestore());
  },
);
