import { FieldValue, Timestamp, getFirestore, type Firestore } from 'firebase-admin/firestore';
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
  /**
   * The ledger field this rule's deadline is measured on. Either a stored
   * deadline (`purgeAfter`, compared against `now`) or an event timestamp the
   * rule measures its own window back from (`completedAt` + 30 days) — that
   * is what `cutoff` below decides.
   */
  dueField: string;
  /**
   * The value `dueField` is compared against: the rule matches rows where
   * `dueField <= cutoff(now)`. A rule whose deadline is stored on the row
   * passes `now` through unchanged; a rule that measures a window back from
   * an event subtracts it here. Keeping this per-rule is what lets two rules
   * with completely different clocks share one engine.
   */
  cutoff: (now: Timestamp) => Timestamp;
  /**
   * Optional equality clause folded into the QUERY (not the in-memory
   * filter). Use it when a composite index for `equals.field` + `dueField`
   * exists, so the rule doesn't read the whole collection every run. A rule
   * without one narrows in `applies` instead — see the two contact rules
   * below, which differ on exactly this point and say why.
   */
  equals?: { field: string; value: unknown };
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
  cutoff: (now) => now,
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

    // `lastError` is the raw exception text from a failed phase — uncapped
    // free text that routinely quotes uids, email addresses and Stripe
    // customer ids straight out of an Auth/Stripe/Firestore error. It is
    // cleared outright when a purge succeeds (see the completion write in
    // purge.ts), so in practice only failed rows still carry one this far.
    if (data['lastError'] !== undefined) redaction['lastError'] = null;

    // Operator notes are staff free text ABOUT a customer, and `byName` is a
    // named employee. `action` and `at` stay so the history still reads as a
    // sequence of interventions; who did it and what they wrote do not.
    // Arrays can't be partially updated in Firestore, so this rewrites the
    // whole array — hence the presence check, same as everywhere else here.
    const actions = data['operatorActions'];
    if (Array.isArray(actions)) {
      redaction['operatorActions'] = actions.map((entry) => ({
        action: (entry as Record<string, unknown>)['action'],
        at: (entry as Record<string, unknown>)['at'],
        byUid: null,
        byName: null,
      }));
    }

    return redaction;
  },
};

/**
 * DECIDED, NOT OVERLOOKED: `companyName` is deliberately NOT redacted.
 *
 * On a `mode: 'immediate'` row the company is often a one-person business
 * named after its owner, so the field can in practice be the requester's own
 * name surviving the blanking of `requestedByName` right above. The decision
 * is to keep it anyway: the company name is the event's OBJECT, not its
 * actor, and an operator history that cannot say which company a deletion
 * was about is not a history. Don't "finish the job" by adding it here.
 */

/**
 * How long `formerMemberContacts` — every former member's name and email,
 * snapshotted by the purge's members phase — may be kept after the company
 * is gone. Thirty days, and NOT `purgeAfter`: that clock belongs to the
 * person who REQUESTED the deletion, and Art. 17(3)(e) does not stretch to
 * cover an ordinary crew member's address just because she happened to work
 * there. Three independent mechanisms land on <= 30 days:
 *
 *   - the mail queue's retry budget is spent in ~30 MINUTES
 *     (`MAX_MAIL_ATTEMPTS = 5`, backoff capped at 30 min) — it cannot
 *     justify keeping addresses for days, let alone years.
 *   - there is no Resend webhook, so the ONLY signal that a `companyDeleted`
 *     never arrived is the `critical_mail_delivery_failed` log line. Cloud
 *     Logging's default retention is 30 days; after that nobody can even
 *     discover the failure, so nobody can act on the addresses either.
 *   - 30 days is exactly `STRANDED_MEMBER_WINDOW_MS` in memberCleanup.ts.
 *     While a `scheduled` member's window is still running, the mail she was
 *     sent has live legal effect for her; once it closes, it doesn't.
 */
const FORMER_MEMBER_CONTACTS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The same data on a ledger that never reached `completed`. A `failed` row
 * has no `completedAt` at all — `completedAt` is written on exactly one line
 * in purge.ts, together with `state: 'completed'` — so without this second
 * rule a crashed purge would quietly keep every former member's address for
 * the full 24 months, through a rule that looks like it covers everything.
 *
 * Ninety days rather than thirty because a `failed` row is an open incident:
 * an operator has to be able to see who was affected long enough to finish
 * the deletion by hand. Measured from `lastHeartbeatAt`, which for a failed
 * row is frozen at the moment of failure (the same write sets `state:
 * 'failed'`, and nothing runs against it afterwards) — so no new field is
 * needed, and the `state` + `lastHeartbeatAt` composite index already in
 * firestore.indexes.json is exactly the one this query wants.
 */
const FAILED_LEDGER_CONTACTS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** True for a row that still carries either of the two per-uid lists. */
function carriesMemberContactData(data: FirebaseFirestore.DocumentData): boolean {
  return Array.isArray(data['formerMemberContacts']) || Array.isArray(data['finalizeMailQueuedUids']);
}

/**
 * Replaces both per-uid lists with an anonymous aggregate.
 *
 * `uid` goes with the name and the address. It is personal data in its own
 * right (Art. 4(1) — a direct key into `users/{uid}` and Auth), and its
 * operator value is zero: a raw uid cannot be rendered as anything
 * meaningful once the user is either deleted or repointed at another
 * company. `formerMemberSummary` carries the whole of what the operator view
 * actually needs — "14 members, 11 kept their account, 2 scheduled, 1
 * already gone" — and is anonymous, so it needs no legal basis at all.
 *
 * `finalizeMailQueuedUids` is the same list of uids with the same absence of
 * a basis (it is the finalize phase's per-uid resume marker) and is removed
 * in the SAME write. Both are removed with `FieldValue.delete()` rather than
 * the `null` this file's identity rule uses, and the difference is
 * deliberate: `null` exists there to keep "redacted" distinguishable from
 * "never existed", and here `formerMemberSummary` plus the marker field
 * already say that unambiguously.
 */
function buildContactsRedaction(data: FirebaseFirestore.DocumentData): Record<string, unknown> {
  const contacts = Array.isArray(data['formerMemberContacts']) ? data['formerMemberContacts'] : [];
  const summary = { total: contacts.length, kept: 0, scheduled: 0, already_gone: 0 };
  for (const contact of contacts) {
    const status = (contact as Record<string, unknown>)['accountStatus'];
    if (status === 'kept' || status === 'scheduled' || status === 'already_gone') summary[status] += 1;
  }

  const redaction: Record<string, unknown> = { formerMemberSummary: summary };
  if (data['formerMemberContacts'] !== undefined) redaction['formerMemberContacts'] = FieldValue.delete();
  if (data['finalizeMailQueuedUids'] !== undefined) redaction['finalizeMailQueuedUids'] = FieldValue.delete();
  return redaction;
}

/**
 * THE GUARD THAT MATTERS ON BOTH CONTACT RULES: neither may ever touch a row
 * that is not in a terminal state. `formerMemberContacts` doubles as the
 * members phase's resume marker (see its docblock in types/company.ts) — a
 * purge that is still `requested` or `executing` can be resumed at any time,
 * and redacting its resume marker would make the resumed run re-process
 * every member it had already finished. The state check is not tidiness; it
 * is what keeps this job from corrupting a live purge.
 *
 * The two rules enforce it differently, on purpose:
 *   - `contacts_completed` filters in `applies`. A composite index for
 *     `state` + `completedAt` does not exist, and querying `completedAt`
 *     alone already selects exactly the completed rows (it is written on one
 *     line, with `state: 'completed'`) — so the state check is a belt to
 *     that braces, held in code.
 *   - `contacts_failed` filters in the QUERY, because `state` +
 *     `lastHeartbeatAt` IS an existing index and `lastHeartbeatAt` on its
 *     own matches every ledger row that ever ran.
 *
 * KNOWN GAP, written down rather than papered over: a purge that keeps
 * timing out never increments `attempts` (a 540s SIGKILL skips the catch
 * block), so it can stay `executing` indefinitely and neither rule will ever
 * reach it. That is the correct trade — breaking a live purge is worse than
 * keeping contacts too long — and the existing signal for it is the
 * `lastResumePhaseCount` warning in purge.ts, which step 6's "stuck" view is
 * meant to surface. Fixing it means fixing stuck purges, not loosening this.
 */
const CONTACTS_COMPLETED_RULE: LedgerRedactionRule = {
  name: 'contacts_completed',
  dueField: 'completedAt',
  cutoff: (now) => Timestamp.fromMillis(now.toMillis() - FORMER_MEMBER_CONTACTS_RETENTION_MS),
  markerField: 'contactsRedactedAt',
  applies: (data) => data['state'] === 'completed' && carriesMemberContactData(data),
  buildRedaction: buildContactsRedaction,
};

const CONTACTS_FAILED_RULE: LedgerRedactionRule = {
  name: 'contacts_failed',
  dueField: 'lastHeartbeatAt',
  cutoff: (now) => Timestamp.fromMillis(now.toMillis() - FAILED_LEDGER_CONTACTS_RETENTION_MS),
  equals: { field: 'state', value: 'failed' },
  markerField: 'contactsRedactedAt',
  applies: (data) => carriesMemberContactData(data),
  buildRedaction: buildContactsRedaction,
};

/**
 * INCOMPLETE UNTIL #325: redacting the ledger does not reach the `mail`
 * collection. Every `companyDeleted` document queued by the finalize phase
 * carries a former member's address in its own `to` field and lives in
 * `mail/{id}` indefinitely — so the addresses this file removes at 30 days
 * still exist one collection over. Mail retention is its own track (issue
 * #325); don't assume the ledger rules below close it.
 */
const REDACTION_RULES: LedgerRedactionRule[] = [
  IDENTITY_REDACTION_RULE,
  CONTACTS_COMPLETED_RULE,
  CONTACTS_FAILED_RULE,
];

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
  let query: FirebaseFirestore.Query = db.collection('companyDeletions');
  if (rule.equals) query = query.where(rule.equals.field, '==', rule.equals.value);
  const candidatesSnap = await query.where(rule.dueField, '<=', rule.cutoff(now)).get();
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
