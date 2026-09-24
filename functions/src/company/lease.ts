import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { CompanyDeletionDocument, CompanyDeletionMirror } from '../types';
import { applyFailedTransition, NO_PROGRESS_LIMIT } from './failDeletion';

/**
 * Shared by every path that can start (or resume) a purge — `executeOverdue`
 * (sweep.ts), `resumeStuck` (sweep.ts), and the `mode: 'immediate'` branch of
 * `onCompanyDeletionCreated` (onDeletionCreated.ts). Originally lived only in
 * sweep.ts and was used by `executeOverdue` alone; a review after the first
 * cut of PR E found the other two paths calling `runCompanyPurge` with NO
 * claim at all — see the review notes this module's functions link back to.
 * Every caller of `runCompanyPurge` MUST go through one of these two
 * functions first. Calling `runCompanyPurge` directly without a claim is the
 * exact bug this file exists to make impossible to repeat.
 */

/**
 * Transactionally flips `requested` → `executing`, on BOTH the company's
 * member-visible `deletion` mirror and the `companyDeletions` ledger, and
 * returns the `requestId` only to the caller that performed the flip. This
 * transaction — not any caller's cadence or the sweep's 30-minute schedule —
 * is the entire double-run guard: two callers racing the same company both
 * read `state: 'requested'`, but Firestore serializes the conflicting
 * writes, so only one commits and the other's re-read sees `state:
 * 'executing'` already and returns `null`. See "Svepet" in the plan —
 * "dubbelkörningsskyddet är en lease, inte frekvensen."
 *
 * Used for the `requested` → `executing` transition specifically:
 * `executeOverdue`'s sweep pass, and the immediate-mode branch of
 * `onCompanyDeletionCreated` (a ledger just created with `mode: 'immediate'`
 * has `scheduledFor` in the past by construction, so `executeOverdue` would
 * also match it on the very next sweep tick if this trigger didn't claim it
 * first — this function is what makes that race harmless either way).
 */
export async function claimRequestedLease(db: Firestore, companyId: string, now: Timestamp): Promise<string | null> {
  return db.runTransaction(async (tx) => {
    const companyRef = db.doc(`companies/${companyId}`);
    const companySnap = await tx.get(companyRef);
    if (!companySnap.exists) return null;

    const deletion = companySnap.data()?.['deletion'] as CompanyDeletionMirror | undefined;
    if (!deletion || deletion.state !== 'requested') return null;

    const requestId = deletion.requestId;
    const ledgerRef = db.doc(`companyDeletions/${requestId}`);
    const ledgerSnap = await tx.get(ledgerRef);
    if (!ledgerSnap.exists || (ledgerSnap.data() as CompanyDeletionDocument)['state'] !== 'requested') {
      return null;
    }

    tx.update(companyRef, { 'deletion.state': 'executing', 'deletion.claimedAt': now });
    // Seeds the no-progress baselines (issue #335) fresh for THIS execution
    // attempt — a company can be requested, purged to failure, requeued by
    // an operator, and requested again in theory, and a stale baseline left
    // over from a previous life of this row must never carry forward into a
    // new one. `progressUnits` itself is NOT reset here: it's a monotonic
    // counter purge.ts keeps bumping across the whole purge's lifetime, and
    // resetting it would make `claimStaleLease`'s very first comparison
    // against a fresh `leaseProgressUnits: 0` baseline look like "progress
    // was made" even when the purge hasn't run a single unit of work yet.
    tx.update(ledgerRef, {
      state: 'executing',
      lastHeartbeatAt: now,
      leaseProgressUnits: 0,
      leaseAttempts: 0,
      noProgressResumes: 0,
    });
    return requestId;
  });
}

/** What `claimStaleLease` decided: whether (and how) it should be resumed. */
export type StaleLeaseClaimResult = 'claimed' | 'not_claimed' | 'failed';

/**
 * The `resumeStuck` equivalent: a lease that's already `executing` but whose
 * heartbeat has gone stale needs its OWN compare-and-swap, distinct from
 * `claimRequestedLease` above (that one only fires on the `requested` →
 * `executing` transition, which a stuck lease has already made). Two
 * overlapping sweep runs finding the same stale `companyDeletions/{id}`
 * would otherwise both call `runCompanyPurge` for it — Cloud Scheduler is
 * at-least-once, so overlapping invocations are a documented possibility,
 * not a hypothetical. Both would append to `formerMemberContacts` via
 * read-modify-write `.update()` calls with no compare-and-swap of their own,
 * queue duplicate `companyDeleted` mail, and write duplicate
 * `deletionAuditLog` rows.
 *
 * This transaction re-reads the ledger and only "wins" (bumps
 * `lastHeartbeatAt` to `now`, claiming the resume) if it's STILL `executing`
 * with a heartbeat older than `staleCutoff` at the moment it commits — the
 * same re-read-inside-the-transaction pattern `claimRequestedLease` uses.
 * The loser's re-read sees the just-bumped heartbeat and returns
 * `'not_claimed'`.
 *
 * ISSUE #335: winning the claim used to be the whole story. But a phase that
 * times out on EVERY invocation gets SIGKILLed before purge.ts's catch block
 * ever runs, so `attempts` never grows and `resumeStuck` (sweep.ts) just
 * calls this again next sweep, forever, with no operator-visible signal.
 * This function now ALSO tracks whether a winning claim represents real
 * forward movement, using two ledger fields purge.ts bumps as it works
 * (`progressUnits`, monotonic) and already tracked (`attempts`) against a
 * baseline snapshot this function itself owns (`leaseProgressUnits`,
 * `leaseAttempts`):
 *
 *   - no baseline yet (`leaseProgressUnits === undefined` — a row from
 *     before this field existed, or one `claimRequestedLease` seeded but
 *     that has since accumulated progress before ever going stale) → seed
 *     the baseline from the CURRENT values and claim normally. This first
 *     stale hit after seeding proves nothing either way, so it is not
 *     counted toward `NO_PROGRESS_LIMIT`.
 *   - `progressUnits` moved since the baseline → real forward movement.
 *     Reset `noProgressResumes` to 0 and re-baseline.
 *   - `progressUnits` didn't move, but `attempts` did → a phase THREW and
 *     was caught normally (purge.ts's own catch block ran, which is only
 *     possible if the process didn't get SIGKILLed) — a different kind of
 *     "something happened", so the counter is left alone (not reset to 0 —
 *     the row still isn't provably making progress — but not incremented
 *     either) and the `attempts` baseline is refreshed so the NEXT
 *     comparison is against this attempt, not a stale one.
 *   - neither moved → `noProgressResumes` increments. At `NO_PROGRESS_LIMIT`
 *     the row is declared `failed` via `applyFailedTransition` (reason
 *     `'no_progress'`) INSIDE this same transaction — its own reads
 *     (`companyRef`, the admins query) happen before any write, same rule
 *     every transaction here follows.
 */
export async function claimStaleLease(
  db: Firestore,
  requestId: string,
  staleCutoff: Timestamp,
  now: Timestamp,
): Promise<StaleLeaseClaimResult> {
  return db.runTransaction(async (tx) => {
    const ledgerRef = db.doc(`companyDeletions/${requestId}`);
    const ledgerSnap = await tx.get(ledgerRef);
    if (!ledgerSnap.exists) return 'not_claimed';

    const ledger = ledgerSnap.data() as CompanyDeletionDocument;
    if (ledger.state !== 'executing') return 'not_claimed';
    const heartbeat = ledger.lastHeartbeatAt;
    if (!heartbeat || heartbeat.toMillis() > staleCutoff.toMillis()) return 'not_claimed';

    const currentProgress = ledger.progressUnits ?? 0;
    const currentAttempts = ledger.attempts ?? 0;

    // No baseline yet — seed it and claim without counting this hit. This
    // branch's only write is the baseline + heartbeat, so no extra reads are
    // needed before it.
    if (ledger.leaseProgressUnits === undefined) {
      tx.update(ledgerRef, {
        lastHeartbeatAt: now,
        leaseProgressUnits: currentProgress,
        leaseAttempts: currentAttempts,
      });
      return 'claimed';
    }

    if (currentProgress !== ledger.leaseProgressUnits) {
      tx.update(ledgerRef, {
        lastHeartbeatAt: now,
        leaseProgressUnits: currentProgress,
        leaseAttempts: currentAttempts,
        noProgressResumes: 0,
      });
      return 'claimed';
    }

    if (currentAttempts !== (ledger.leaseAttempts ?? 0)) {
      tx.update(ledgerRef, {
        lastHeartbeatAt: now,
        leaseAttempts: currentAttempts,
      });
      return 'claimed';
    }

    const noProgressResumes = (ledger.noProgressResumes ?? 0) + 1;

    if (noProgressResumes >= NO_PROGRESS_LIMIT) {
      // All reads before any write, per this transaction's own rule —
      // `ledgerSnap` above is already read; these two are the only ones
      // `applyFailedTransition` needs.
      const companyRef = db.doc(`companies/${ledger.companyId}`);
      const companySnap = await tx.get(companyRef);
      const adminsSnap = await tx.get(
        db.collection(`companies/${ledger.companyId}/members`).where('role', '==', 'admin'),
      );

      // Persisted separately from applyFailedTransition's own writes so the
      // operator history can render "N of NO_PROGRESS_LIMIT resumes made no
      // progress" using the count that actually tripped the threshold, not
      // whatever it was one resume earlier.
      tx.update(ledgerRef, { noProgressResumes });

      applyFailedTransition(tx, {
        db,
        ledgerRef,
        ledger,
        companySnap,
        adminsSnap,
        reason: 'no_progress',
        now,
      });
      return 'failed';
    }

    tx.update(ledgerRef, { lastHeartbeatAt: now, noProgressResumes });
    return 'claimed';
  });
}
