import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import type { CompanyDeletionDocument, CompanyDeletionFailureReason } from '../types';
import { formatDateFull } from './format';
import { appUrl } from '../appUrl';

/**
 * Consecutive no-progress stale-lease claims (see `claimStaleLease` in
 * lease.ts) before a purge that never throws — a phase that SIGKILLs on
 * every invocation, issue #335's whole premise — is declared `failed`
 * anyway. Three, not one: a single stale claim finding no movement is
 * ordinary (the previous run may simply still be mid-flight when its
 * heartbeat went stale by a hair), and `STALE_LEASE_MS` in sweep.ts is
 * already 60 minutes, so three strikes is three full hours of confirmed
 * zero progress before this gives up on it.
 */
export const NO_PROGRESS_LIMIT = 3;

/**
 * Everything `applyFailedTransition` needs, ALL pre-read by the caller
 * before any write happens — Firestore transactions require every read to
 * happen before the first write, and this function issues nothing but
 * writes. `companySnap` and `adminsSnap` are `null` when the caller has
 * nothing to offer (no company doc to check, e.g.) rather than omitted,
 * so a mirror of this file never has to guess whether a field was left out
 * on purpose.
 */
export interface ApplyFailedTransitionArgs {
  /**
   * Only used to mint NEW document references (`db.collection('mail').doc()`)
   * for the notification mail — never read from here. Every read this
   * function needs comes in as one of the snapshots below.
   */
  db: Firestore;
  ledgerRef: FirebaseFirestore.DocumentReference;
  ledger: CompanyDeletionDocument;
  /** Pre-read `companies/{companyId}` snapshot, or `null` if the caller didn't fetch one (e.g. already known to be gone). */
  companySnap: FirebaseFirestore.DocumentSnapshot | null;
  /** Pre-read `companies/{companyId}/members` query, filtered to `role == 'admin'`, or `null`. */
  adminsSnap: FirebaseFirestore.QuerySnapshot | null;
  reason: CompanyDeletionFailureReason;
  now: Timestamp;
}

/**
 * The ONE transition that moves a `companyDeletions/{requestId}` ledger to
 * `state: 'failed'` — issue #331 (customers never saw a failed purge) and
 * #335 (a purge that times out on every invocation never even reaches this
 * point through the normal catch block). Called from two places:
 *
 *   - purge.ts's catch block, once `attempts` exhausts `MAX_ATTEMPTS`
 *     (`reason: 'attempts_exhausted'`).
 *   - lease.ts's `claimStaleLease`, once `NO_PROGRESS_LIMIT` consecutive
 *     stale-lease claims find no forward movement at all
 *     (`reason: 'no_progress'`) — the SIGKILL case above, detected from
 *     OUTSIDE the dying process instead of from inside it.
 *
 * A THIRD caller exists only on the Next.js side: `lib/companyDeletionFailWrites.ts`
 * mirrors every write below (`reason: 'operator'`) for the operator's
 * "mark as failed" action, because App Hosting cannot import `functions/src`
 * — see that file's own docblock and the parity test that keeps the two from
 * drifting apart. THIS is why this function is written as a pure
 * write-builder over a transaction and pre-read snapshots, with no
 * `firebase-functions` import anywhere in its write path except the single,
 * isolated `logMarkedFailed` call at the bottom — the Next twin can (and
 * does) copy every write verbatim and simply swap that one call out for its
 * own logging.
 *
 * Writes, all inside the caller's transaction:
 *
 *   1. The ledger: `state: 'failed'`, `failureReason`, `failedAt: now`, and
 *      `lastHeartbeatAt: now` — the same field the sweep's stuck-lease
 *      detection reads, kept fresh here so a `failed` row's heartbeat means
 *      "the moment it failed", not some earlier, increasingly stale value.
 *      That freshness is also what `purgeLogs.ts`'s `CONTACTS_FAILED_RULE`
 *      measures its 90-day contacts-retention window from.
 *
 *   2. The member-visible mirror, `companies/{companyId}.deletion.state`,
 *      ONLY when `companySnap` exists AND its `deletion.requestId` still
 *      matches THIS ledger's `requestId`. Both guards matter: the company
 *      document can be gone entirely (a `finalize`-phase crash right before
 *      `state: 'completed'` — see purge.ts's own idempotency notes), and a
 *      mismatched `requestId` means a NEWER deletion request has since
 *      overwritten the mirror (cancelled, then requested again) — writing
 *      `'failed'` over that would misreport an unrelated, currently-running
 *      request as stalled.
 *
 *   3. `companyDeletionFailed` mail to admins with an email on file,
 *      falling back to `ledger.requestedByEmail` when no admin remains AND
 *      `ledger.mode === 'window'` (an admin-less immediate-mode row has
 *      already deleted its one member's account, and mailing the address
 *      that account no longer controls would be pointless). Only sent when
 *      `ledger.failedNotifiedAt` is not already set — this function is
 *      called every time a stale claim finds no progress until the
 *      threshold is hit, and once from the catch block, but the mail must
 *      go out exactly once per request. `failedNotifiedAt`/
 *      `failedNotifiedCount` are written in the SAME write as the mail
 *      docs, so a retried transaction can never observably send mail twice
 *      or record having sent it without actually queuing anything. Each
 *      recipient's mail data carries `recipientRole` ('admin' | 'requester')
 *      so the template's footer sentence is true for HER specifically, and
 *      `billingStopped` (whether `completedPhases` actually includes
 *      'stripe' yet) so the mail never claims billing stopped when the
 *      purge never got that far.
 *
 *      NOTE (issue #334): `companyDeletionFailed`'s mail data carries no
 *      requester identity at all — no `requestedByName`, nothing derived
 *      from `ledger.requestSource` — so `formatRequesterDisplay`
 *      (company/format.ts) does not apply here. Unlike the requested/
 *      reminder/deleted mails, this one is never "X asked for this
 *      company to be deleted"; it is "the deletion ran into a problem",
 *      which is true regardless of who requested it. Do not add a
 *      requester field to this template without also deciding whether it
 *      needs the same operator-email substitution the other three mails
 *      apply.
 *
 * Does NOT touch `attempts`, `lastError`, or anything phase/progress
 * related — those stay each caller's own responsibility (purge.ts's catch
 * block writes `attempts`/`lastError` in the SAME transaction, in its own
 * `tx.update` call; lease.ts has nothing else to write). Multiple
 * `tx.update()` calls against the same `ledgerRef` inside one transaction
 * are fine — each is a partial merge, applied in the order queued, the same
 * way two `WriteBatch.update()` calls to one document compose.
 */
export function applyFailedTransition(
  tx: FirebaseFirestore.Transaction,
  { db, ledgerRef, ledger, companySnap, adminsSnap, reason, now }: ApplyFailedTransitionArgs,
): void {
  tx.update(ledgerRef, {
    state: 'failed',
    failureReason: reason,
    failedAt: now,
    lastHeartbeatAt: now,
  });

  if (companySnap && companySnap.exists) {
    const deletion = companySnap.data()?.['deletion'] as { requestId?: string } | undefined;
    if (deletion?.requestId === ledger.requestId) {
      tx.update(companySnap.ref, { 'deletion.state': 'failed' });
    }
  }

  if (!ledger.failedNotifiedAt) {
    // Each recipient is tagged with WHICH kind of recipient she is — the
    // mail's footer sentence has to be true for her specifically, and "you
    // are getting this because you are an administrator" is false for the
    // `requestedByEmail` fallback below (review fix: that fallback recipient
    // used to get the admin footer regardless). Built as objects, not a
    // flat email list, precisely so that distinction survives to the mail
    // doc.
    const recipients: { email: string; recipientRole: 'admin' | 'requester' }[] = [];
    if (adminsSnap) {
      for (const adminDoc of adminsSnap.docs) {
        const email = adminDoc.data()['email'] as string | undefined;
        if (email) recipients.push({ email, recipientRole: 'admin' });
      }
    }
    // No admin left with an email — fall back to whoever requested it, but
    // only for 'window' mode. An 'immediate' request's sole member (its one
    // admin) had her account deleted as part of the SAME purge that just
    // failed a later phase; her address is not a live inbox to chase this
    // into, and finding out "who requested this" for an immediate row is
    // not the fallback's job.
    if (recipients.length === 0 && ledger.mode === 'window' && ledger.requestedByEmail) {
      recipients.push({ email: ledger.requestedByEmail, recipientRole: 'requester' });
    }

    if (recipients.length > 0) {
      // Snapshot taken at request time (issue #361) — see the doc comment
      // on `CompanyDeletionDocument.timezone` in functions/src/types.ts.
      const timezone = ledger.timezone ?? 'UTC';
      const requestedAtFormatted = formatDateFull(ledger.requestedAt, timezone);
      const failedAtFormatted = formatDateFull(now, timezone);
      const openUrl = appUrl('/');
      // True only once the purge has actually run its stripe phase — an
      // operator's "mark as failed" (or `no_progress` tripping while still
      // IN the stripe phase) can reach `failed` before Stripe was ever
      // touched. Review fix: the copy used to claim this unconditionally.
      const billingStopped = (ledger.completedPhases ?? []).includes('stripe');

      for (const { email, recipientRole } of recipients) {
        const mailRef = db.collection('mail').doc();
        tx.set(mailRef, {
          to: email,
          status: 'queued',
          template: 'companyDeletionFailed',
          companyId: ledger.companyId,
          data: {
            companyName: ledger.companyName,
            requestedAtFormatted,
            failedAtFormatted,
            openUrl,
            recipientRole,
            billingStopped,
          },
        });
      }

      tx.update(ledgerRef, {
        failedNotifiedAt: now,
        failedNotifiedCount: recipients.length,
      });
    }
  }

  logMarkedFailed(reason, ledger.requestId, ledger.companyId);
}

/**
 * Isolated deliberately: this is the ONLY `firebase-functions` import in
 * this file's write path. Kept in its own one-line function so the
 * Next-side twin (`lib/companyDeletionFailWrites.ts`, which cannot import
 * `firebase-functions` — App Hosting is a different runtime) can copy every
 * write above verbatim and simply drop or replace this one call, instead of
 * having to pick a logging import out of the middle of a bigger function.
 * Never logs an email address — only the reason and the two ids, both of
 * which are already operator-visible via the ledger itself.
 */
function logMarkedFailed(reason: CompanyDeletionFailureReason, requestId: string, companyId: string): void {
  logger.error('company_deletion_marked_failed', {
    action: 'company_deletion_marked_failed',
    reason,
    requestId,
    companyId,
  });
}
