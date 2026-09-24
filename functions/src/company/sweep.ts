import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';
import type { CompanyDeletionDocument, CompanyDeletionMirror } from '../types';
import { runCompanyPurge } from './purge';
import { formatDateFull, buildCancelUrl } from './format';
import { appUrl } from '../appUrl';
import { claimRequestedLease, claimStaleLease } from './lease';

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');

/**
 * A purge that hasn't heartbeat in this long is presumed stuck (crashed
 * instance, timed-out invocation) rather than merely slow — the sweep runs
 * every 30 minutes, so two full missed sweep cycles is a conservative bar
 * that won't fight a purge that's still legitimately working through a
 * large subtree.
 */
const STALE_LEASE_MS = 60 * 60 * 1000; // 60 minutes

const REMINDER_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours

export interface SweepResult {
  executed: number;
  reminded: number;
  resumed: number;
  /** Rows `claimStaleLease` declared `'failed'` this sweep (issue #335's no-progress detection) — never resumed, so never counted in `resumed`. */
  failedNoProgress: number;
}

/**
 * Pass 1 — claims and starts every company whose window has expired.
 * `mode: 'immediate'` requests are normally started directly by
 * `onCompanyDeletionCreated`, not by this pass — this is only the safety
 * net for one that, for whatever reason, is still sitting in `requested`
 * with `scheduledFor <= now` (which is true for an immediate request from
 * the moment it's created; `onCompanyDeletionCreated` claims its OWN lease
 * via the same `claimRequestedLease` before calling `runCompanyPurge`, so
 * this pass finding it already `executing` and skipping it is the normal,
 * expected outcome, not a race it loses).
 */
async function executeOverdue(db: Firestore, now: Timestamp): Promise<number> {
  const overdueSnap = await db
    .collection('companies')
    .where('deletion.state', '==', 'requested')
    .where('deletion.scheduledFor', '<=', now)
    .get();

  let count = 0;
  for (const companyDoc of overdueSnap.docs) {
    const requestId = await claimRequestedLease(db, companyDoc.id, now);
    if (!requestId) continue;
    await runCompanyPurge(db, requestId);
    count++;
  }
  return count;
}

/**
 * Pass 2 — sends the single reminder to every admin of a company whose
 * window closes within 48h and who hasn't been reminded yet.
 * `deletion.remindedAt` is set inside the SAME transaction that queues the
 * mail docs, so re-running the sweep (or two overlapping runs) can never
 * send a second reminder for the same request — the transaction's read of
 * `remindedAt` and its write of it can't interleave with another run's.
 */
async function sendReminders(db: Firestore, now: Timestamp): Promise<number> {
  const cutoff = Timestamp.fromMillis(now.toMillis() + REMINDER_WINDOW_MS);
  const candidatesSnap = await db
    .collection('companies')
    .where('deletion.state', '==', 'requested')
    .where('deletion.scheduledFor', '<=', cutoff)
    .get();

  let count = 0;
  for (const companyDoc of candidatesSnap.docs) {
    const sent = await claimAndQueueReminder(db, companyDoc.id, now);
    if (sent) count++;
  }
  return count;
}

async function claimAndQueueReminder(db: Firestore, companyId: string, now: Timestamp): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const companyRef = db.doc(`companies/${companyId}`);
    const companySnap = await tx.get(companyRef);
    if (!companySnap.exists) return false;

    const companyData = companySnap.data()!;
    const deletion = companyData['deletion'] as CompanyDeletionMirror | undefined;
    if (!deletion || deletion.state !== 'requested' || deletion.remindedAt) return false;

    const scheduledFor = deletion.scheduledFor;
    // Defensive re-check: the outer query's window is a superset (it also
    // matches anything already overdue) — an overdue one belongs to pass 1,
    // not here.
    if (scheduledFor.toMillis() <= now.toMillis()) return false;

    const ledgerRef = db.doc(`companyDeletions/${deletion.requestId}`);
    const ledgerSnap = await tx.get(ledgerRef);
    if (!ledgerSnap.exists) return false;
    const ledger = ledgerSnap.data() as CompanyDeletionDocument;

    const adminsSnap = await tx.get(
      db.collection(`companies/${companyId}/members`).where('role', '==', 'admin'),
    );
    if (adminsSnap.empty) {
      // Nothing to send, but still mark it reminded — an admin-less company
      // is not this sweep's problem to solve, and re-checking it every 30
      // minutes forever would be.
      tx.update(companyRef, { 'deletion.remindedAt': now });
      return true;
    }

    const token = ledger.cancelTokenIds?.[0];
    if (!token) {
      // Should not happen — onCompanyDeletionCreated mints the token before
      // any 'window'-mode ledger can reach this point — but a silent
      // fallback to a URL that cancels nothing would hand an admin a
      // 48h-left reminder with a dead-end CTA. Log loudly so it's
      // investigated rather than discovered by a confused admin.
      logger.error('claimAndQueueReminder: no cancel token on ledger, reminder CTA will not cancel anything', {
        companyId,
        requestId: deletion.requestId,
      });
    }
    const stopUrl = token ? buildCancelUrl(token) : appUrl('/');
    const daysRemaining = Math.max(
      1,
      Math.ceil((scheduledFor.toMillis() - now.toMillis()) / (24 * 60 * 60 * 1000)),
    );

    tx.update(companyRef, { 'deletion.remindedAt': now });

    for (const adminDoc of adminsSnap.docs) {
      const admin = adminDoc.data();
      const email = admin['email'] as string | undefined;
      if (!email) continue;
      const mailRef = db.collection('mail').doc();
      tx.set(mailRef, {
        to: email,
        status: 'queued',
        template: 'companyDeletionReminder',
        companyId,
        data: {
          companyName: companyData['name'] ?? '',
          requestedByName: deletion.requestedByName,
          requestedAtFormatted: formatDateFull(deletion.requestedAt),
          scheduledForFormatted: formatDateFull(scheduledFor),
          daysRemaining,
          stopUrl,
        },
      });
    }

    return true;
  });
}

/**
 * Pass 3 — resumes any purge whose lease is stale: `state: 'executing'` but
 * no heartbeat within `STALE_LEASE_MS`. `runCompanyPurge` is resumable by
 * construction (see its own docblock), so "resuming" here is just calling
 * it again with the same `requestId` — it picks up from `completedPhases`.
 *
 * `claimStaleLease` is this pass's own compare-and-swap — Cloud Scheduler
 * is documented at-least-once, so two overlapping sweep invocations both
 * finding the same stale `companyDeletions/{id}` is a real possibility, not
 * a hypothetical. Without a claim here, both would call `runCompanyPurge`
 * concurrently for the same `requestId`: duplicate `companyDeleted` mail,
 * lost updates on `formerMemberContacts` (a read-modify-write `.update()`
 * with no compare-and-swap), duplicate `deletionAuditLog` rows.
 *
 * ISSUE #335: `claimStaleLease` now returns one of THREE outcomes, not a
 * boolean. `runCompanyPurge` is only ever called on `'claimed'` — a
 * `'failed'` result means the transaction already declared this row failed
 * (no-progress detection tripped `NO_PROGRESS_LIMIT`) and there is nothing
 * left to resume; calling `runCompanyPurge` on it anyway would just have it
 * read a ledger no longer `executing` and return immediately (see that
 * function's own early-return guard), but skipping the call here says so
 * more directly and saves the read.
 */
async function resumeStuck(db: Firestore, now: Timestamp): Promise<{ resumed: number; failedNoProgress: number }> {
  const staleCutoff = Timestamp.fromMillis(now.toMillis() - STALE_LEASE_MS);
  const stuckSnap = await db
    .collection('companyDeletions')
    .where('state', '==', 'executing')
    .where('lastHeartbeatAt', '<=', staleCutoff)
    .get();

  let resumed = 0;
  let failedNoProgress = 0;
  for (const doc of stuckSnap.docs) {
    const outcome = await claimStaleLease(db, doc.id, staleCutoff, now);
    if (outcome === 'not_claimed') continue;
    if (outcome === 'failed') {
      failedNoProgress++;
      logger.warn('runCompanyDeletionSweep: purge declared failed — no progress across repeated stale-lease resumes', {
        requestId: doc.id,
      });
      continue;
    }
    await runCompanyPurge(db, doc.id);
    resumed++;
  }
  return { resumed, failedNoProgress };
}

/**
 * The sweep, exported as a plain function of `(db)` for the same reason
 * `runMailRetrySweep`/`runCompanyPurge` are — directly callable from an
 * emulator test with no scheduler invocation. `companyDeletionSweep` below
 * is the thin `onSchedule` wrapper.
 */
export async function runCompanyDeletionSweep(db: Firestore): Promise<SweepResult> {
  const now = Timestamp.now();

  const executed = await executeOverdue(db, now);
  const reminded = await sendReminders(db, now);
  const { resumed, failedNoProgress } = await resumeStuck(db, now);

  logger.info('runCompanyDeletionSweep: sweep complete', { executed, reminded, resumed, failedNoProgress });
  return { executed, reminded, resumed, failedNoProgress };
}

export const companyDeletionSweep = onSchedule(
  {
    schedule: 'every 30 minutes',
    region: 'europe-west1',
    secrets: [STRIPE_SECRET_KEY],
    // Same sizing as onCompanyDeletionCreated — this sweep also runs
    // runCompanyPurge synchronously, both for newly-overdue requests and
    // for resuming a stuck one.
    timeoutSeconds: 540,
    memory: '1GiB',
  },
  async () => {
    await runCompanyDeletionSweep(getFirestore());
  },
);
