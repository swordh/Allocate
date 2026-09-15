import { createHash } from 'crypto';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, getFirestore, type Firestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  TRIGGERED_BY_STRANDED_ACCOUNT_ENFORCED,
  TRIGGERED_BY_STRANDED_ACCOUNT_SPARED,
} from '../deletionAuditLogTriggers';

/**
 * Enforcement sweep for issue #252 step 6 — the "Hård ordningsregel" in
 * plan/det-k-nns-som-att-stateless-conway.md. `cleanupOneMember`
 * (memberCleanup.ts) SCHEDULES a stranded member's account for deletion by
 * writing `users/{uid}.pendingDeletion = { scheduledFor, requestId }`; this
 * file is the sweep that eventually ACTS on that schedule. Its precondition
 * — that at least one route back to having a company clears the field
 * atomically with the write that gives her one back — is met twice over:
 * `setupNewCompany` (actions/auth.ts:262) and `acceptInvitation.ts`'s
 * transaction (Part A of this same change). Both existed before this sweep
 * went live, per the ordering rule.
 *
 * THIS IS THE MOST DESTRUCTIVE CODE IN THE REPOSITORY. It deletes real user
 * accounts — Firestore doc, Firebase Auth record — on a timer, with no human
 * in the loop. Every design choice below is biased toward NOT deleting: a
 * candidate's clock and memberships are both re-checked live, and — because a
 * read that only INFORMS a later, separate write is not a guarantee, only a
 * narrowed race — that re-check and the deletes/spare it authorises happen
 * inside ONE Firestore transaction (`processCandidateTransaction` below), not
 * as two sequential operations. See `confirmSoleMember`
 * (lib/queries/deletionOutcomes.ts) for the sibling instance of the same
 * philosophy: the scheduled field is the counter, a live read is the
 * confirmation, and the live read always wins — the difference here is that
 * "wins" has to mean atomically, because the thing being authorised is
 * unrecoverable.
 *
 * The concrete writer this transaction is racing: `acceptInvitationByToken`
 * (functions/src/auth/acceptInvitation.ts) writes
 * `users/{uid}/memberships/{companyId}` and clears `users/{uid}.pendingDeletion`
 * inside its OWN transaction (Part A of this same change). If she accepts an
 * invitation while this sweep is mid-flight on her uid, Firestore's
 * optimistic concurrency control on the `users/{uid}` document forces one of
 * the two transactions to retry rather than letting both commit against a
 * stale view of the world — so this sweep either observes her new membership
 * and spares her, or commits first and her acceptance retries against
 * whatever state that leaves (rare, and never the silent-deletion outcome a
 * merely-sequential read-then-write would have allowed).
 */

/**
 * `deleted_auth_failed` is its own outcome, not folded into `deleted`, for a
 * reason worth stating plainly: `deleted` must mean the account is
 * COMPLETELY gone (Firestore doc AND Auth record), because that's the
 * counter someone will eventually wire an alert or a dashboard off of. If
 * `adminAuth.deleteUser` throws after the Firestore transaction already
 * committed the deletion, the Firestore side is unrecoverably done but the
 * Auth record survives (see `processCandidate`'s docblock for the known
 * asymmetry this represents) — that is a materially different, and worse,
 * state than a clean `deleted`, and a type that can't distinguish the two
 * would let that difference hide inside a number that looks fine.
 */
export type StrandedCandidateOutcome = 'deleted' | 'deleted_auth_failed' | 'spared' | 'skipped';

export interface StrandedAccountSweepResult {
  /** Accounts COMPLETELY removed: Firestore doc gone AND Auth record gone.
   *  Never includes a row where the Auth delete failed — see `deletedAuthFailed`. */
  deleted: number;
  /** Firestore doc deleted, but `adminAuth.deleteUser` then threw — the Auth
   *  record survives, orphaned. See `processCandidate`'s docblock for why the
   *  next sweep run cannot find her to retry. Counted separately from
   *  `deleted` specifically so `deleted` stays honest on its own. */
  deletedAuthFailed: number;
  /** Accounts spared because a live membership was found; `pendingDeletion` cleared. */
  spared: number;
  /** Candidates that turned out not to be due after all (see `evaluateCandidate`). */
  skipped: number;
  /** Candidates whose processing threw — logged individually, sweep continues. */
  failed: number;
}

interface PendingDeletion {
  scheduledFor: Timestamp;
  requestId: string;
}

/**
 * Re-derives `pendingDeletion` from an already-fetched `users/{uid}`
 * snapshot, or `null` when this uid is no longer a valid candidate at all:
 *
 *   - the document is gone (a self-deletion or an earlier sweep pass already
 *     removed it — see the idempotency note on `runStrandedAccountSweep`)
 *   - `pendingDeletion` is absent (cancelled between the query and now)
 *   - `pendingDeletion.scheduledFor` is now in the future (a reset clock
 *     always wins — nothing here ever re-derives a NEW deadline)
 *
 * Pure and synchronous on purpose: it's called twice on two different kinds
 * of read (the cheap pre-check below, and the transactional read that
 * actually authorises anything), and the two must apply IDENTICAL logic —
 * a second, hand-copied version of this check inside the transaction is
 * exactly how the two would drift.
 */
function stillDue(userSnap: FirebaseFirestore.DocumentSnapshot, now: Timestamp): PendingDeletion | null {
  if (!userSnap.exists) return null;

  const pendingDeletion = userSnap.data()?.['pendingDeletion'] as PendingDeletion | undefined;
  if (!pendingDeletion) return null;

  if (pendingDeletion.scheduledFor.toMillis() > now.toMillis()) return null;

  return pendingDeletion;
}

/**
 * Cheap, NON-authoritative early-out: a plain (non-transactional) read of
 * `users/{uid}`, used only to skip opening a transaction for the ordinary
 * case where a candidate the outer query returned has already been settled
 * by an earlier, failed pass of this same sweep, or was never really a
 * candidate at all by the time this uid's turn comes up in the loop. This
 * buys nothing in correctness — `processCandidateTransaction` re-derives
 * the exact same decision from a transactional read regardless of what this
 * function returns, and is the only thing anything irreversible is ever
 * conditioned on. Removing this function entirely would only cost a few
 * wasted transactions per run, never a wrong outcome.
 */
async function precheckStillDue(db: Firestore, uid: string, now: Timestamp): Promise<boolean> {
  const userSnap = await db.doc(`users/${uid}`).get();
  return stillDue(userSnap, now) !== null;
}

/**
 * THE function that may irreversibly delete or spare a candidate — see the
 * module docblock for why this has to be one transaction rather than a read
 * followed by a separate write. `tx.get` on a live query
 * (`users/{uid}/memberships`) is exactly as valid inside a transaction as
 * `tx.get` on a single document reference; both reads below land in the
 * transaction's read set, and Firestore aborts and retries the whole
 * transaction if either `users/{uid}` or any of its `memberships` documents
 * changes before commit — which is precisely the guarantee a plain,
 * sequential "read memberships, then batch-write" cannot offer: with that
 * shape, a membership created between the read and the write is invisible
 * to the read and gets deleted right along with the account it was created
 * on. Here, that same new membership either gets read by THIS attempt (and
 * spares her) or forces this transaction to retry against a world where it
 * exists — there is no ordering in which it is both missed by the read and
 * destroyed by the write.
 *
 * DELIBERATELY does NOT check whether the memberships it finds point at
 * companies that still exist. A stale pointer to an already-deleted company
 * would, in principle, still mean she is stranded — but confirming that
 * costs an extra read per membership for a benefit that is close to zero:
 * `setupNewCompany` is already hardened to skip a stale pointer when she
 * creates a new company (issue #252 point 2, actions/auth.ts), so sparing
 * her here costs nothing — she can still create a company, and she can
 * still delete her own account through the ordinary `deleteAccount` flow if
 * she wants to. Deleting her WRONGLY, on the other hand, costs everything —
 * an irreversible Auth + Firestore deletion with no undo. That asymmetry is
 * the whole reason this function stops at "does at least one membership
 * document exist," full stop. Do not "optimise" this into resolving stale
 * pointers later — the day someone does, a membership pointing at a
 * long-deleted company starts blocking deletions that were correctly due,
 * for a saving that was never worth the risk in the first place.
 *
 * This is the same defence-in-depth `confirmSoleMember` uses for its own,
 * mirror-image decision: a stored field is never trusted alone to authorise
 * something irreversible. The scheduled field is the counter; this live,
 * transactional read is the confirmation.
 *
 * No Stripe anonymisation and no booking/equipment anonymisation on the
 * delete branch — a stranded user has no company by definition (that is
 * what `pendingDeletion` means), so there is nothing of hers left in any
 * surviving company's subtree to anonymise. This is a deliberate omission,
 * not an oversight.
 *
 * NO FINAL EMAIL IS SENT EITHER, and the reason is a retention one, not a
 * "nobody to mail" one (an earlier draft of this comment claimed mailing an
 * about-to-be-erased address was mail "to nobody" — that doesn't hold up:
 * her inbox is completely unrelated to whether her Firestore doc still
 * exists, and the GDPR review correctly called that out as a non-sequitur).
 * The real reason: queuing a final notice would write her email address
 * into the `mail` collection, and that collection currently has NO
 * retention policy at all (issue #325) — this sweep would be creating a
 * fresh, unerased copy of the very address it exists to erase, in order to
 * tell her it was erased. `deleteAccount` sends nothing for the same
 * underlying reason, and the `companyDeleted` mail already gave her this
 * exact date, so nothing is lost by staying silent here.
 *
 * THIS TRADE FLIPS ONCE #325 CLOSES: with `mail` under real retention, a
 * final notice becomes the better behaviour, not a worse one. Whoever closes
 * #325 should revisit this decision rather than assume it's settled forever.
 *
 * Does NOT touch Firebase Auth — `getAuth().deleteUser` has no place inside
 * a Firestore transaction (it isn't part of it, and Firestore may retry this
 * callback on contention, which must never risk calling `deleteUser` more
 * than once for one attempt). `processCandidate` below calls it strictly
 * AFTER this transaction has committed, matching `deleteAccount`'s own
 * "Firestore first, Auth absolutely last" ordering.
 */
async function processCandidateTransaction(
  db: Firestore,
  uid: string,
  now: Timestamp,
): Promise<StrandedCandidateOutcome> {
  const userRef = db.doc(`users/${uid}`);
  const membershipsQuery = db.collection(`users/${uid}/memberships`);

  return db.runTransaction(async (tx) => {
    const [userSnap, membershipsSnap] = await Promise.all([tx.get(userRef), tx.get(membershipsQuery)]);

    const pendingDeletion = stillDue(userSnap, now);
    if (!pendingDeletion) return 'skipped';

    const userIdHash = createHash('sha256').update(uid).digest('hex');

    if (!membershipsSnap.empty) {
      // Spared: the exact gap Part A of this change closes for
      // `acceptInvitationByToken` (a membership appearing without the
      // schedule being cleared), and the shape any FUTURE route back to
      // having a company would also need to guard against if it forgets the
      // same clear. Reaching this branch at all means such a gap existed;
      // this transaction is the safety net for it, not the primary defence.
      tx.set(userRef, { pendingDeletion: FieldValue.delete() }, { merge: true });
      tx.set(db.collection('deletionAuditLog').doc(), {
        userIdHash,
        clearedAt: FieldValue.serverTimestamp(),
        requestId: pendingDeletion.requestId,
        triggeredBy: TRIGGERED_BY_STRANDED_ACCOUNT_SPARED,
      });
      return 'spared';
    }

    for (const membershipDoc of membershipsSnap.docs) {
      tx.delete(membershipDoc.ref);
    }
    tx.delete(userRef);
    tx.set(db.collection('deletionAuditLog').doc(), {
      userIdHash,
      deletedAt: FieldValue.serverTimestamp(),
      requestId: pendingDeletion.requestId,
      triggeredBy: TRIGGERED_BY_STRANDED_ACCOUNT_ENFORCED,
    });
    return 'deleted';
  });
}

/**
 * Processes exactly one candidate uid. `precheckStillDue` is a cheap,
 * non-authoritative early-out (see its own docblock); the ENTIRE decision of
 * record, and every write that follows from it, happens inside
 * `processCandidateTransaction`. `getAuth().deleteUser` runs strictly after
 * that transaction has committed — see that function's docblock for why it
 * cannot live inside the transaction itself.
 *
 * KNOWN ASYMMETRY, same one `deleteAccount` has and handles the same way: if
 * the transaction commits a `deleted` outcome and `adminAuth.deleteUser`
 * then throws, the Auth record is orphaned — and unlike `deleteAccount`'s
 * own case, the next run of THIS sweep cannot find her to retry, because its
 * query is over `users/{uid}` and that document is now gone. The outcome
 * returned in that case is `deleted_auth_failed`, NOT `deleted` — see
 * `StrandedAccountSweepResult`'s own docblock for why that distinction is
 * load-bearing rather than cosmetic. Logged with its own action string so
 * it is discoverable rather than silently swallowed; no new recovery
 * mechanism is invented for it here, matching `deleteAccount`.
 */
async function processCandidate(db: Firestore, uid: string, now: Timestamp): Promise<StrandedCandidateOutcome> {
  if (!(await precheckStillDue(db, uid, now))) return 'skipped';

  const outcome = await processCandidateTransaction(db, uid, now);

  if (outcome === 'deleted') {
    try {
      await getAuth().deleteUser(uid);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('runStrandedAccountSweep: Auth record delete failed after Firestore was already removed', {
        uid: uid.slice(0, 8) + '...',
        error: message,
        action: 'stranded_sweep_auth_delete_failed',
      });
      return 'deleted_auth_failed';
    }
  }

  return outcome;
}

/**
 * The sweep, exported as a plain function of `(db)` — same pattern as
 * `runCompanyDeletionSweep` (sweep.ts) and `purgeCompanyDeletionLogsSweep`
 * (purgeLogs.ts): directly callable from an emulator test with no scheduler
 * invocation, and no logic lives inside the `onSchedule` closure below
 * (unlike `autoBookingStatusUpdate.ts` — see that file's own docblock for
 * why that's the anti-pattern here).
 *
 * IDEMPOTENT AND RESUMABLE BY CONSTRUCTION: running this sweep twice in a
 * row deletes nothing extra. A deleted candidate's `users/{uid}` document is
 * gone, so the query on the second run simply doesn't return her uid at all
 * — there is no marker to forget to check and no state that could cause a
 * second, redundant delete. A spared candidate no longer carries
 * `pendingDeletion`, so the same is true of her. Per-candidate failures are
 * naturally resumable the same way `cleanupOneMember`'s callers rely on:
 * whatever a failed candidate's actual state is at the top of the NEXT run,
 * `processCandidate` re-derives the right outcome live rather than trusting
 * any assumption about how far a previous, failed attempt got.
 *
 * ONE CANDIDATE'S FAILURE NEVER ABORTS THE SWEEP for the others — see the
 * per-candidate try/catch below, same reasoning as `runRedactionRule` in
 * purgeLogs.ts: a single bad row (a transient Firestore error, an Auth
 * quota blip) must not park every other stranded account for another 24
 * hours.
 */
export async function runStrandedAccountSweep(db: Firestore): Promise<StrandedAccountSweepResult> {
  const now = Timestamp.now();

  // Query: `pendingDeletion.scheduledFor <= now`, a single range filter on
  // one nested field with no other clause. Firestore's automatic
  // single-field indexes serve exactly this shape — no composite index is
  // needed, and none is added to firestore.indexes.json for it. See
  // `purgeLogs.ts` (~line 399-401) for the identical reasoning applied to
  // `purgeAfter` there: a composite index is only required when a query
  // combines a range/inequality filter with another filter (an `array-contains`,
  // an equality clause, a second range field), or orders by a field other
  // than the one being range-filtered. This query does neither. The emulator
  // never requires composite indexes either way, so this can't be confirmed
  // by a passing test — it has to be reasoned out, which is what this
  // comment is.
  const candidatesSnap = await db.collection('users').where('pendingDeletion.scheduledFor', '<=', now).get();

  let deleted = 0;
  let deletedAuthFailed = 0;
  let spared = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidateDoc of candidatesSnap.docs) {
    const uid = candidateDoc.id;
    try {
      const outcome = await processCandidate(db, uid, now);
      if (outcome === 'deleted') deleted += 1;
      else if (outcome === 'deleted_auth_failed') deletedAuthFailed += 1;
      else if (outcome === 'spared') spared += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      logger.error('runStrandedAccountSweep: candidate processing failed, continuing with the rest', {
        uid: uid.slice(0, 8) + '...',
        error: message,
      });
    }
  }

  logger.info('runStrandedAccountSweep: sweep complete', { deleted, deletedAuthFailed, spared, skipped, failed });
  return { deleted, deletedAuthFailed, spared, skipped, failed };
}

export const strandedAccountSweep = onSchedule(
  {
    // Thirty-day clock — every 24 hours is ample margin and matches the
    // cadence `purgeCompanyDeletionLogs` uses for its own monthslong windows.
    schedule: 'every 24 hours',
    region: 'europe-west1',
    timeoutSeconds: 300,
    memory: '256MiB',
  },
  async () => {
    await runStrandedAccountSweep(getFirestore());
  },
);
