import { Timestamp, getFirestore, type Firestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';

/**
 * Firestore's own WriteBatch cap is 500 operations; 490 leaves headroom and
 * matches `functions/src/admin/purgeAuditLogs.ts`. Every redaction write in
 * this file goes through a chunk of at most this size — see
 * `runRedactionRule`.
 */
export const BATCH_LIMIT = 490;

/** Per-rule outcome; `byRule` in the sweep result is keyed by rule name. */
export interface RedactionRuleResult {
  /** Rows past this rule's deadline that hadn't been redacted by it yet. */
  eligible: number;
  /** Rows actually written (a failed chunk's rows are NOT counted here). */
  redacted: number;
  /** Chunks committed successfully. */
  batches: number;
  /** Chunks whose commit threw. Their rows stay eligible for the next run. */
  failedBatches: number;
}

export interface PurgeCompanyDeletionLogsResult {
  eligible: number;
  redacted: number;
  failedBatches: number;
  byRule: Record<string, RedactionRuleResult>;
}

/**
 * One retention rule over `companyDeletions`. Deliberately a data shape
 * rather than inline code in the sweep, because a SECOND rule is already
 * known to be coming and must not require rewriting this function:
 * `formerMemberContacts` (the name/email snapshot the purge's members phase
 * copies onto the ledger) has to be redacted on a SHORTER window than the
 * 24 months below — an ordinary crew member's address is not carried by the
 * Art. 17(3)(e) basis that covers the person who REQUESTED the deletion.
 * That window is not decided yet (a GDPR analysis is running separately), so
 * the rule is not written here; the shape it will slot into is.
 *
 * Adding that rule means: one more entry in `REDACTION_RULES`, one more
 * deadline field written at request time, and one more single-field index on
 * that deadline field in `firestore.indexes.json`. Nothing in
 * `runRedactionRule` or the sweep changes.
 */
interface LedgerRedactionRule {
  /** Stable key for logs and `byRule`. */
  name: string;
  /** The ledger field carrying THIS rule's own deadline. Each rule has its own. */
  dueField: string;
  /** Written when this rule has run on a row; also what makes the rule idempotent. */
  markerField: string;
  /**
   * Optional extra precondition, evaluated per row. A rule that only applies
   * to rows carrying a particular field (the coming `formerMemberContacts`
   * rule, for instance) says so here rather than by widening the query.
   */
  applies?: (data: FirebaseFirestore.DocumentData) => boolean;
  /**
   * The fields this rule blanks, for this specific row. Returning only the
   * fields that are actually present on the row is the rule's own
   * responsibility — see the identity rule below for why that matters.
   */
  buildRedaction: (data: FirebaseFirestore.DocumentData) => Record<string, unknown>;
}

/**
 * The 24-month identity redaction. See the GDPR/Art. 17(3)(e) docblock on
 * `CompanyDeletionRecord` in types/company.ts for the legal basis (and for
 * the fact that counsel has not confirmed that reading yet): the EVENT has
 * to survive for step 6's operator history, the person behind it does not.
 * The row is never deleted.
 *
 * WHY `null` AND NOT `FieldValue.delete()`:
 * these two outcomes have to stay distinguishable in the operator view,
 * and only `null` keeps them apart —
 *
 *   - field present, value `null`  → there WAS an identity here and this job
 *     removed it. The view can honestly render "redacted".
 *   - field absent                 → there never was one. `canceledByUid` on
 *     a deletion that was never cancelled is the everyday case, and it is
 *     absent for a completely different reason.
 *
 * `FieldValue.delete()` would collapse both into "absent" and make a redacted
 * row indistinguishable from a row that never had a canceller — the operator
 * would have no way to tell "we scrubbed this" from "this never happened".
 *
 * For the same reason the `canceled*` fields are only nulled when they are
 * actually present: writing `canceledByUid: null` onto a deletion nobody ever
 * cancelled would fabricate exactly the "redacted" marker described above for
 * an event that never occurred.
 */
const IDENTITY_REDACTION_RULE: LedgerRedactionRule = {
  name: 'identity',
  dueField: 'purgeAfter',
  markerField: 'identityRedactedAt',
  buildRedaction: (data) => {
    const redaction: Record<string, unknown> = {
      requestedByUid: null,
      requestedByName: null,
      requestedByEmail: null,
    };
    for (const field of ['canceledByUid', 'canceledByName', 'canceledByEmail'] as const) {
      if (data[field] !== undefined) redaction[field] = null;
    }
    return redaction;
  },
};

const REDACTION_RULES: LedgerRedactionRule[] = [IDENTITY_REDACTION_RULE];

/**
 * Applies one rule across every row past its deadline, in `BATCH_LIMIT`-sized
 * chunks.
 *
 * `functions/src/admin/purgeAuditLogs.ts` is the cautionary tale the plan
 * calls out by name: it used to commit everything in ONE `batch.commit()`,
 * which throws outright past 500 documents and logged nothing when it did.
 * Hence both the chunking and the per-chunk `try/catch`: one chunk that fails
 * must not silently take the rest of the sweep with it, and it must be
 * visible in the logs when it does.
 */
async function runRedactionRule(
  db: Firestore,
  rule: LedgerRedactionRule,
  now: Timestamp,
): Promise<RedactionRuleResult> {
  // Firestore has no "field is absent" query, and a rule's marker field is
  // absent (not null) on every row that hasn't been redacted by it yet —
  // querying `== null` here would silently match nothing, forever. Query on
  // the deadline field only (the index's leading field) and filter the
  // already-redacted rows out in code instead.
  //
  // Consequence worth knowing before "optimising" this: the composite
  // `purgeAfter` + `identityRedactedAt` index in firestore.indexes.json (added
  // by PR C for this job) can therefore never be used BY this query — a
  // single-field range on `purgeAfter` is served by Firestore's automatic
  // single-field index. It is left in place rather than deleted here because
  // step 6's operator view is the other plausible consumer; deleting an index
  // is its own decision, not a side effect of this PR.
  const candidatesSnap = await db.collection('companyDeletions').where(rule.dueField, '<=', now).get();
  const eligibleDocs = candidatesSnap.docs.filter((doc) => {
    const data = doc.data();
    if (data[rule.markerField]) return false;
    return rule.applies ? rule.applies(data) : true;
  });

  const result: RedactionRuleResult = {
    eligible: eligibleDocs.length,
    redacted: 0,
    batches: 0,
    failedBatches: 0,
  };

  for (let start = 0; start < eligibleDocs.length; start += BATCH_LIMIT) {
    const chunk = eligibleDocs.slice(start, start + BATCH_LIMIT);
    const batch = db.batch();
    for (const doc of chunk) {
      // The marker goes in the SAME batch as the blanking, never a second
      // commit afterwards. A crash between two commits would leave a row
      // that is redacted but unmarked (re-redacted forever — harmless but
      // dishonest about WHEN it happened) or marked but unredacted (identity
      // retained past its deadline, and invisible to every later run because
      // the marker filters it out). One atomic write makes both impossible.
      batch.update(doc.ref, { ...rule.buildRedaction(doc.data()), [rule.markerField]: now });
    }

    try {
      await batch.commit();
      result.redacted += chunk.length;
      result.batches += 1;
    } catch (err) {
      // Do NOT rethrow here: the remaining chunks are independent, and one
      // bad row must not park the whole retention job. The rows in this
      // chunk keep their (absent) marker and are picked up again next run.
      result.failedBatches += 1;
      logger.error('purgeCompanyDeletionLogsSweep: redaction chunk failed', {
        rule: rule.name,
        chunkStart: start,
        chunkSize: chunk.length,
        firstDocId: chunk[0]?.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * The retention sweep over `companyDeletions`. Runs every rule in
 * `REDACTION_RULES`; today that is the single 24-month identity redaction.
 *
 * Exported as a plain function of `(db)` like every other function in this
 * neighborhood — see `runCompanyPurge`'s docblock in
 * functions/src/company/purge.ts for the pattern and why the `onSchedule`
 * wrapper below is kept this thin.
 */
export async function purgeCompanyDeletionLogsSweep(db: Firestore): Promise<PurgeCompanyDeletionLogsResult> {
  const now = Timestamp.now();
  const byRule: Record<string, RedactionRuleResult> = {};
  let eligible = 0;
  let redacted = 0;
  let failedBatches = 0;

  for (const rule of REDACTION_RULES) {
    const ruleResult = await runRedactionRule(db, rule, now);
    byRule[rule.name] = ruleResult;
    eligible += ruleResult.eligible;
    redacted += ruleResult.redacted;
    failedBatches += ruleResult.failedBatches;

    logger.info('purgeCompanyDeletionLogsSweep: rule complete', {
      rule: rule.name,
      eligible: ruleResult.eligible,
      redacted: ruleResult.redacted,
      batches: ruleResult.batches,
      failedBatches: ruleResult.failedBatches,
    });
  }

  logger.info('purgeCompanyDeletionLogsSweep: complete', { eligible, redacted, failedBatches });

  return { eligible, redacted, failedBatches, byRule };
}

export const purgeCompanyDeletionLogs = onSchedule(
  { schedule: 'every monday 04:00', region: 'europe-west1' },
  async () => {
    const result = await purgeCompanyDeletionLogsSweep(getFirestore());
    // The sweep itself swallows a failed chunk on purpose (the other chunks
    // still have to run). Throwing HERE is what makes the failure visible as
    // a failed scheduled execution rather than a line in a log nobody reads;
    // the rows themselves are simply retried next Monday.
    if (result.failedBatches > 0) {
      throw new Error(
        `purgeCompanyDeletionLogs: ${result.failedBatches} redaction chunk(s) failed; ${result.redacted} of ${result.eligible} eligible rows redacted`,
      );
    }
  },
);
