import { FieldValue, getFirestore, type Firestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';
import type Stripe from 'stripe';
import { getStripeClient } from './stripeClient';
import { appUrl } from '../appUrl';
import type { CompanyBilling } from '../types';

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');

/** Statuses under which a missing billing email is still worth chasing. Any other status — 'canceled', 'incomplete', or absent entirely — means there is nothing left to invoice, so the flag is cleared instead of reminded on. */
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due']);

/** Reminders repeat weekly (the sweep itself runs weekly — see `billingEmailReminder` below), so this is really "at least one sweep cycle has passed since the last mail," not a distinct cadence of its own. Set just under 7 days so a sweep that runs slightly early or late one week never skips a company outright. */
const REMINDER_INTERVAL_MS = 6 * 24 * 60 * 60 * 1000;

export interface BillingEmailReminderResult {
  /** A reminder mail was queued to at least one admin and `billing.lastReminderAt` was bumped. */
  sent: number;
  /** `billing` was removed — the company is gone, its deletion is pending, its subscription is no longer worth chasing, or Stripe already has an email on the customer again. */
  cleared: number;
  /** Not yet due (less than `REMINDER_INTERVAL_MS` since the last reminder), or nothing to send (no admin has an email) — the flag stays as-is either way. */
  skipped: number;
  /** Per-company processing threw — logged individually, sweep continues. */
  failed: number;
}

type ProcessOutcome = 'sent' | 'cleared' | 'skipped';

/**
 * One company's worth of work: decide whether `billing.emailMissingSince`
 * still describes a real, current problem, and either clear it, send a
 * reminder, or leave it for next week.
 *
 * Deliberately NOT wrapped in a `runTransaction` the way `sweep.ts`'s own
 * `claimAndQueueReminder` is: that one race-guards a mail that can only ever
 * be sent ONCE (`remindedAt` gates it forever after). This mail repeats every
 * week by design, so two overlapping sweep runs sending one reminder each a
 * few minutes apart is a mildly annoying duplicate, not the kind of
 * unbounded-spam or "must never happen twice" failure a transaction earns
 * its cost for. The Stripe `customers.retrieve` call below is also a network
 * round-trip that has no business running inside a Firestore transaction
 * callback, which Firestore may retry on contention.
 */
async function processCompany(
  db: Firestore,
  stripe: Stripe,
  companyId: string,
  now: Date,
): Promise<ProcessOutcome> {
  const companyRef = db.doc(`companies/${companyId}`);
  const companySnap = await companyRef.get();

  // Company gone entirely — nothing left to clear or chase. The query that
  // found this candidate can never match it again once the document itself
  // is gone, so there is no "clear the flag or it keeps coming back" concern
  // here the way there is for the branches below.
  if (!companySnap.exists) return 'skipped';

  const data = companySnap.data() ?? {};
  const billing = data['billing'] as CompanyBilling | undefined;
  // Already cleared by a concurrent run, or by the portal picking up a new
  // email between the outer query and this read.
  if (!billing?.emailMissingSince) return 'skipped';

  const clearBilling = async (): Promise<'cleared'> => {
    await companyRef.update({ billing: FieldValue.delete() });
    return 'cleared';
  };

  // A company actually on its way out — `state: 'requested'` (window or
  // immediate, still counting down) or `'executing'` (the purge has claimed
  // it and is working through it) — is not worth chasing: the purge's own
  // Stripe phase (purge.ts's runStripePhase) handles the Stripe side, and
  // there will be no admins left to mail shortly regardless.
  //
  // `'failed'` is deliberately NOT included here. It means the purge
  // exhausted its retry budget and is sitting there needing operator
  // attention (see `CompanyDeletionState` in types/company.ts) — the company
  // document, its subscription and its admins are all still very much
  // present, so there is no reason to stop chasing a real billing-email gap
  // just because an unrelated deletion attempt stalled. (A cancelled
  // deletion doesn't need handling here at all: per that same type's doc
  // comment, cancelling removes the whole `deletion` field rather than
  // writing a 'cancelled' state, so it already falls through to the ordinary
  // subscription-status check below.)
  const deletionState = (data['deletion'] as { state?: string } | undefined)?.state;
  if (deletionState === 'requested' || deletionState === 'executing') return clearBilling();

  const subStatus = data['subscription']?.['status'] as string | undefined;
  if (!subStatus || !ACTIVE_SUBSCRIPTION_STATUSES.has(subStatus)) return clearBilling();

  const stripeCustomerId = data['stripeCustomerId'] as string | undefined;
  if (!stripeCustomerId) return clearBilling();

  let customer: Stripe.Customer | Stripe.DeletedCustomer;
  try {
    customer = await stripe.customers.retrieve(stripeCustomerId);
  } catch (err) {
    // Best-effort, non-fatal by design (same posture as
    // `runAccountDeletion`'s own Stripe calls and purge.ts's Stripe phase):
    // a transient Stripe outage must not clear a real "no billing email"
    // flag out from under a company that still needs the reminder. Leave it
    // as-is; next week's sweep tries again.
    const message = err instanceof Error ? err.message : String(err);
    logger.error('billingEmailReminder: Stripe customer retrieve failed, leaving billing flag as-is', {
      companyId,
      stripeCustomerId,
      error: message,
    });
    return 'skipped';
  }

  // Customer deleted, or an admin already set a new email straight in the
  // Stripe portal (bypassing the app entirely) — either way the flag no
  // longer describes reality.
  if (customer.deleted || customer.email) return clearBilling();

  const lastReminderAtMs = new Date(billing.lastReminderAt).getTime();
  if (Number.isFinite(lastReminderAtMs) && now.getTime() - lastReminderAtMs < REMINDER_INTERVAL_MS) {
    return 'skipped';
  }

  const adminsSnap = await db.collection(`companies/${companyId}/members`).where('role', '==', 'admin').get();
  const adminsWithEmail = adminsSnap.docs.filter((doc) => typeof doc.data()['email'] === 'string' && doc.data()['email']);
  if (adminsWithEmail.length === 0) {
    // Nothing to send, but the problem is still real — leave the flag set so
    // next week's sweep checks again, rather than mark it cleared with
    // nobody ever having been told. Not `lastReminderAt` bumped either: an
    // admin appearing later should get the very first mail promptly, not
    // wait out whatever window an unsent "reminder" would otherwise start.
    return 'skipped';
  }

  const nowIso = now.toISOString();
  const settingsUrl = appUrl('settings/subscription');
  const companyName = (data['name'] as string | undefined) ?? '';

  const batch = db.batch();
  for (const adminDoc of adminsWithEmail) {
    const email = adminDoc.data()['email'] as string;
    const mailRef = db.collection('mail').doc();
    batch.set(mailRef, {
      to: email,
      status: 'queued',
      template: 'billingEmailMissing',
      companyId,
      priority: 'normal',
      data: { companyName, settingsUrl, isReminder: true },
      createdAt: nowIso,
    });
  }
  batch.update(companyRef, { 'billing.lastReminderAt': nowIso });
  await batch.commit();

  return 'sent';
}

/**
 * Weekly sweep for `CompanyBilling` (types/company.ts) — chases every company
 * whose Stripe billing email went missing (via `runAccountDeletion`'s Stripe
 * billing-contact anonymisation, actions/account.ts) until an admin sets a
 * new one, the subscription stops needing one, or the company itself is
 * gone. Exported as a plain function of `(db, stripe, now)` — same
 * testability shape as `runStrandedAccountSweep`/`runCompanyDeletionSweep` —
 * so an emulator or unit test can call it directly with no scheduler
 * invocation and a controlled clock.
 *
 * Query: `billing.emailMissingSince > ''`, a single range filter on one
 * field — no composite index required, same reasoning as the
 * `pendingDeletion.scheduledFor` query in strandedAccountSweep.ts.
 *
 * ONE COMPANY'S FAILURE NEVER ABORTS THE SWEEP FOR THE OTHERS — per-company
 * try/catch below, same posture as every other sweep in this codebase.
 */
export async function runBillingEmailReminder(
  db: Firestore,
  stripe: Stripe,
  now: Date = new Date(),
): Promise<BillingEmailReminderResult> {
  const candidatesSnap = await db.collection('companies').where('billing.emailMissingSince', '>', '').get();

  let sent = 0;
  let cleared = 0;
  let skipped = 0;
  let failed = 0;

  for (const companyDoc of candidatesSnap.docs) {
    try {
      const outcome = await processCompany(db, stripe, companyDoc.id, now);
      if (outcome === 'sent') sent += 1;
      else if (outcome === 'cleared') cleared += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      logger.error('billingEmailReminder: company processing failed, continuing with the rest', {
        companyId: companyDoc.id,
        error: message,
      });
    }
  }

  logger.info('billingEmailReminder: sweep complete', { sent, cleared, skipped, failed });
  return { sent, cleared, skipped, failed };
}

export const billingEmailReminder = onSchedule(
  {
    schedule: 'every monday 09:00',
    timeZone: 'Europe/Stockholm',
    region: 'europe-west1',
    timeoutSeconds: 300,
    memory: '256MiB',
    secrets: [STRIPE_SECRET_KEY],
  },
  async () => {
    const stripe = getStripeClient(STRIPE_SECRET_KEY.value());
    await runBillingEmailReminder(getFirestore(), stripe);
  },
);
