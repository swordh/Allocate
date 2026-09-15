import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { CompanyDeletionDocument, CompanyDeletionMirror } from '../types';

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
    tx.update(ledgerRef, { state: 'executing', lastHeartbeatAt: now });
    return requestId;
  });
}

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
 * The loser's re-read sees the just-bumped heartbeat and returns `false`.
 */
export async function claimStaleLease(
  db: Firestore,
  requestId: string,
  staleCutoff: Timestamp,
  now: Timestamp,
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const ledgerRef = db.doc(`companyDeletions/${requestId}`);
    const ledgerSnap = await tx.get(ledgerRef);
    if (!ledgerSnap.exists) return false;

    const ledger = ledgerSnap.data() as CompanyDeletionDocument;
    if (ledger.state !== 'executing') return false;
    const heartbeat = ledger.lastHeartbeatAt;
    if (!heartbeat || heartbeat.toMillis() > staleCutoff.toMillis()) return false;

    tx.update(ledgerRef, { lastHeartbeatAt: now });
    return true;
  });
}
