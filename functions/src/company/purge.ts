import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import type { CompanyDeletionDocument, CompanyDeletionPhase } from '../types';
import { cleanupOneMember } from './memberCleanup';
import { getStripeClient } from './stripeClient';
import { formatDateFull } from './format';

/** Matches actions/account.ts and actions/team.ts's chunked-WriteBatch convention. */
const BATCH_LIMIT = 490;

/** Purge attempts budget — after this many failed runs, the ledger is marked `failed`. */
const MAX_ATTEMPTS = 5;

/**
 * Approximate heartbeat cadence while a purge is running. Written at every
 * phase boundary and, within the two phases that can run long (members,
 * subtree), after every unit of work — so in practice heartbeats land much
 * more often than this for any company of realistic size. This constant
 * exists mainly to document the "~15s" figure from the plan and is not
 * wired to a wall-clock timer: a `setInterval` would fire during emulator
 * tests too and complicate teardown for no real benefit, since the
 * per-unit-of-work heartbeats below already satisfy the sweep's stuck-lease
 * detection at any realistic company size.
 */
export const HEARTBEAT_TARGET_MS = 15_000;

/**
 * `recursiveDelete` per TOP-LEVEL SUBCOLLECTION under the company, not once
 * on the company document itself. This is a new pattern in this repo — the
 * rest of the codebase (actions/account.ts, actions/team.ts) uses chunked
 * `WriteBatch` loops over query results instead, because those operations
 * are SELECTIVE: every document has to be individually judged (is this
 * booking's `userId` this uid? is this equipment's `approverId`?). Nothing
 * here is selective — every document under the company is going, full stop
 * — so re-deriving a tree walk by hand would just be reimplementing what
 * `recursiveDelete` already does, and `equipment/{id}/units/{id}` (the one
 * genuinely nested collection in this schema) would need that walk to go
 * two levels deep. Per-top-collection (rather than one call on the company
 * doc) is deliberate for three reasons: it gives per-collection progress a
 * heartbeat can report, it lets a crash resume without re-deleting
 * collections that already finished (see `runSubtreePhase`), and it leaves
 * the company document itself untouched here — "finalize" deletes it last,
 * once every mail is queued.
 */
const SUBTREE_COLLECTIONS = ['bookings', 'equipment', 'categories', 'invitations', 'members', '_meta'] as const;

/**
 * Top-level collections that carry a denormalized `companyId` field but are
 * NOT nested under `companies/{cid}` — found via query, not tree walk, so
 * they use the chunked-`WriteBatch` house pattern like the rest of the repo,
 * not `recursiveDelete`.
 */
const ORPHAN_COLLECTIONS = ['companyEvents', 'operatorNotes', 'operatorFeedback', 'stripeFailedPayments'] as const;

async function commitAndReset(db: Firestore, batch: FirebaseFirestore.WriteBatch): Promise<FirebaseFirestore.WriteBatch> {
  await batch.commit();
  return db.batch();
}

// ── Phase 1: Stripe ───────────────────────────────────────────────────────────

/**
 * Cancels the subscription without proration and anonymises (never deletes)
 * the Stripe customer — invoices survive for Bokföringslagen's seven years,
 * same trade-off as `actions/account.ts`'s own Stripe anonymisation
 * (account.ts:539-562). Best-effort and non-fatal by design: a company must
 * not become impossible to delete because Stripe is briefly unreachable, or
 * because this company never had a paid subscription in the first place.
 */
async function runStripePhase(db: Firestore, companyId: string): Promise<void> {
  const companyRef = db.doc(`companies/${companyId}`);
  const companySnap = await companyRef.get();
  if (!companySnap.exists) return;

  const data = companySnap.data() ?? {};
  const stripeCustomerId = data['stripeCustomerId'] as string | undefined;
  const subscriptionId = data['subscription']?.['stripeSubscriptionId'] as string | undefined;
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!stripeCustomerId) {
    logger.info('runCompanyPurge: stripe phase — no stripeCustomerId, nothing to do', { companyId });
    return;
  }
  if (!secretKey) {
    logger.warn('runCompanyPurge: stripe phase — STRIPE_SECRET_KEY not set, skipping', { companyId });
    return;
  }

  try {
    const stripe = getStripeClient(secretKey);
    if (subscriptionId) {
      await stripe.subscriptions.cancel(subscriptionId, { prorate: false });
    }
    await stripe.customers.update(stripeCustomerId, {
      email: 'deleted@allocate.invalid',
      name: 'Deleted Company',
      metadata: { deletedAt: new Date().toISOString() },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('runCompanyPurge: stripe phase failed, continuing purge', { companyId, error: message });
  }
}

// ── Phase 2: invitation bearer-token mirrors ───────────────────────────────────

/**
 * `invitations/{token}` mirrors are bearer tokens resolvable by anyone
 * holding the link — they must die before "who was invited" is lost, which
 * is why this runs before the "members" phase copies contacts and well
 * before "subtree" deletes the `companies/{cid}/invitations` docs that carry
 * the `token` field this reads. Outside the company tree, found via a plain
 * subcollection read, so this uses the chunked-`WriteBatch` house pattern.
 */
async function runInvitationsPhase(db: Firestore, companyId: string): Promise<void> {
  const invitationsSnap = await db.collection(`companies/${companyId}/invitations`).get();

  let batch = db.batch();
  let opCount = 0;
  for (const doc of invitationsSnap.docs) {
    const token = doc.data()['token'] as string | undefined;
    if (!token) continue;
    batch.delete(db.doc(`invitations/${token}`));
    opCount++;
    if (opCount >= BATCH_LIMIT) {
      batch = await commitAndReset(db, batch);
      opCount = 0;
    }
  }
  if (opCount > 0) await batch.commit();
}

// ── Phase 3: members ────────────────────────────────────────────────────────────

/**
 * Runs `cleanupOneMember` for every member of the company being purged, and
 * copies each member's name/email into the ledger's `formerMemberContacts`
 * — the one place those addresses survive once "subtree" deletes the
 * `companies/{cid}/members` docs that carry them.
 *
 * Resumable at per-member granularity: `formerMemberContacts` on the ledger
 * IS the resume marker. A uid is only appended after `cleanupOneMember`
 * returns successfully, and the ledger is updated before the next uid
 * starts — so a crash mid-list resumes by skipping every uid already
 * present, never redoing committed work. See the field's doc comment in
 * types/company.ts.
 */
async function runMembersPhase(
  db: Firestore,
  companyId: string,
  requestId: string,
  ledgerRef: FirebaseFirestore.DocumentReference,
  existingContacts: NonNullable<CompanyDeletionDocument['formerMemberContacts']>,
): Promise<NonNullable<CompanyDeletionDocument['formerMemberContacts']>> {
  const membersSnap = await db.collection(`companies/${companyId}/members`).get();
  const contacts = [...existingContacts];
  const done = new Set(contacts.map((c) => c.uid));

  for (const doc of membersSnap.docs) {
    const uid = doc.id;
    if (done.has(uid)) continue;

    const data = doc.data();
    const outcome = await cleanupOneMember(db, companyId, uid, requestId);

    contacts.push({
      uid,
      name: (data['name'] as string | undefined) ?? '',
      email: (data['email'] as string | undefined) ?? '',
      accountStatus: outcome.accountStatus,
    });
    done.add(uid);

    await ledgerRef.update({ formerMemberContacts: contacts, lastHeartbeatAt: Timestamp.now() });
  }

  return contacts;
}

// ── Phase 4: subtree ─────────────────────────────────────────────────────────────

/**
 * Idempotent by construction: `recursiveDelete` on an already-empty (or
 * already nonexistent) collection resolves immediately with nothing to do.
 * That means a resumed purge can safely redo this entire phase from
 * scratch instead of tracking per-collection completion — collections a
 * prior attempt already finished are a cheap no-op, and the ones it didn't
 * reach get deleted normally. This is deliberately simpler than the
 * per-uid resume tracking `runMembersPhase` needs, because that phase's
 * work (Auth claims, refresh-token revocation, mail-worthy account
 * scheduling) is NOT safely re-runnable the same way — this phase's is.
 */
async function runSubtreePhase(
  db: Firestore,
  companyId: string,
  ledgerRef: FirebaseFirestore.DocumentReference,
): Promise<void> {
  for (const name of SUBTREE_COLLECTIONS) {
    const ref = db.collection(`companies/${companyId}/${name}`);
    await db.recursiveDelete(ref);
    await ledgerRef.update({
      [`phaseCounts.subtree_${name}`]: 1,
      lastHeartbeatAt: Timestamp.now(),
    });
  }
}

// ── Phase 5: orphans ─────────────────────────────────────────────────────────────

/**
 * Documents that reference the company via a denormalized `companyId` field
 * but live at the top level, outside `companies/{cid}` entirely — so
 * `recursiveDelete` never reaches them. Found by query, deleted with the
 * chunked-`WriteBatch` house pattern.
 */
async function runOrphansPhase(db: Firestore, companyId: string): Promise<void> {
  for (const name of ORPHAN_COLLECTIONS) {
    const snap = await db.collection(name).where('companyId', '==', companyId).get();
    let batch = db.batch();
    let opCount = 0;
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
      opCount++;
      if (opCount >= BATCH_LIMIT) {
        batch = await commitAndReset(db, batch);
        opCount = 0;
      }
    }
    if (opCount > 0) await batch.commit();
  }
}

// ── Phase 6: finalize ────────────────────────────────────────────────────────────

/**
 * Queues "company deleted" mail to every former member (not just admins —
 * this is the one deletion-lifecycle mail everyone gets, per the design
 * brief), deletes the company document itself, and closes the ledger.
 *
 * `accountAlsoDeleted` is true only for a contact whose `accountStatus` came
 * back `already_gone` from the members phase — see `MemberAccountStatus`'s
 * docblock in memberCleanup.ts for why that is a materially different case
 * from `scheduled`, which must NOT claim the account is gone: it isn't, it
 * has thirty days left and the recipient can still sign in.
 */
async function runFinalizePhase(
  db: Firestore,
  requestId: string,
  companyId: string,
  ledger: CompanyDeletionDocument,
): Promise<void> {
  const contacts = ledger.formerMemberContacts ?? [];
  const deletedAtFormatted = formatDateFull(Timestamp.now());
  const requestedAtFormatted = formatDateFull(ledger.requestedAt);

  let batch = db.batch();
  let opCount = 0;
  for (const contact of contacts) {
    if (!contact.email) continue;
    const accountAlsoDeleted = contact.accountStatus === 'already_gone';
    const mailRef = db.collection('mail').doc();
    batch.set(mailRef, {
      to: contact.email,
      status: 'queued',
      template: 'companyDeleted',
      // The last message a member whose account is gone will ever get from
      // us — see the docblock on companyDeletedEmail's `priority` handling
      // in mailDelivery.ts.
      priority: 'critical',
      companyId,
      data: {
        companyName: ledger.companyName,
        requestedByName: ledger.requestedByName,
        requestedAtFormatted,
        deletedAtFormatted,
        mode: ledger.mode,
        accountAlsoDeleted,
        ctaUrl: accountAlsoDeleted ? 'https://allocate.at/signup' : 'https://allocate.at/company/new',
      },
    });
    opCount++;
    if (opCount >= BATCH_LIMIT) {
      batch = await commitAndReset(db, batch);
      opCount = 0;
    }
  }
  if (opCount > 0) await batch.commit();

  // No tombstone — see "Verkställd radering raderar företagsdokumentet" in
  // the plan: a leftover shell would keep showing up in the operator
  // customer list, match the webhook's customer search, and keep the
  // per-member read rule alive for a session running on stale claims.
  await db.doc(`companies/${companyId}`).delete();

  await db.collection('companyDeletions').doc(requestId).update({
    state: 'completed',
    completedAt: Timestamp.now(),
    lastHeartbeatAt: Timestamp.now(),
  });
}

// ── Orchestrator ─────────────────────────────────────────────────────────────────

async function markPhaseComplete(
  ledgerRef: FirebaseFirestore.DocumentReference,
  phase: CompanyDeletionPhase,
  completed: Set<CompanyDeletionPhase>,
): Promise<void> {
  completed.add(phase);
  await ledgerRef.update({
    phase,
    completedPhases: Array.from(completed),
    lastHeartbeatAt: Timestamp.now(),
  });
}

/**
 * Runs (or resumes) the purge of one company, driven entirely by the
 * `companyDeletions/{requestId}` ledger doc — no other input. Phases run in
 * strict order (stripe → invitations → members → subtree → orphans →
 * finalize) and a phase already present in `ledger.completedPhases` is
 * skipped outright, which is what makes a crash mid-purge resumable: call
 * this again with the same `requestId` and it picks up where it left off.
 *
 * Exported as a plain function of `(db, requestId)` — no `onSchedule` /
 * `onDocumentCreated` closure — so both this PR's emulator tests and the two
 * production callers (the immediate-mode branch of `onCompanyDeletionCreated`
 * and the sweep's lease-winning branch) can invoke it directly. Matches the
 * `deliverMail`/`runMailRetrySweep` shape already established in
 * functions/src/email — see autoStatusUpdate.ts for the pattern this
 * deliberately does NOT copy (everything inside the `onSchedule` closure,
 * untestable without a live scheduler invocation).
 *
 * On phase failure: increments `attempts`, records `lastError`, and — once
 * `attempts` reaches `MAX_ATTEMPTS` — sets `state: 'failed'`, which is what
 * step 6's "stuck" operator view will hang off of. Does not rethrow: a
 * failed purge is recorded, not crashed out of, so the sweep's stuck-lease
 * pass can find and retry it on its own schedule rather than relying on
 * Cloud Functions' infra-level retry (which has no idea what a "phase" is).
 */
export async function runCompanyPurge(db: Firestore, requestId: string): Promise<void> {
  const ledgerRef = db.collection('companyDeletions').doc(requestId);
  const ledgerSnap = await ledgerRef.get();
  if (!ledgerSnap.exists) {
    logger.error('runCompanyPurge: no ledger doc found', { requestId });
    return;
  }

  const ledger = ledgerSnap.data() as CompanyDeletionDocument;
  const companyId = ledger.companyId;
  const completed = new Set<CompanyDeletionPhase>(ledger.completedPhases ?? []);

  try {
    if (!completed.has('stripe')) {
      await runStripePhase(db, companyId);
      await markPhaseComplete(ledgerRef, 'stripe', completed);
    }

    if (!completed.has('invitations')) {
      await runInvitationsPhase(db, companyId);
      await markPhaseComplete(ledgerRef, 'invitations', completed);
    }

    let contacts = ledger.formerMemberContacts ?? [];
    if (!completed.has('members')) {
      contacts = await runMembersPhase(db, companyId, requestId, ledgerRef, contacts);
      await markPhaseComplete(ledgerRef, 'members', completed);
    }

    if (!completed.has('subtree')) {
      await runSubtreePhase(db, companyId, ledgerRef);
      await markPhaseComplete(ledgerRef, 'subtree', completed);
    }

    if (!completed.has('orphans')) {
      await runOrphansPhase(db, companyId);
      await markPhaseComplete(ledgerRef, 'orphans', completed);
    }

    if (!completed.has('finalize')) {
      const finalSnap = await ledgerRef.get();
      const finalLedger = { ...(finalSnap.data() as CompanyDeletionDocument), formerMemberContacts: contacts };
      await runFinalizePhase(db, requestId, companyId, finalLedger);
      // No markPhaseComplete here — runFinalizePhase already set state to
      // 'completed' and deleted the company doc; writing 'phase: finalize'
      // afterwards would race a `completedPhases` update against a ledger
      // update that just declared the whole thing done.
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = (ledger.attempts ?? 0) + 1;
    logger.error('runCompanyPurge: phase failed', { requestId, companyId, attempts, error: message });

    const update: Record<string, unknown> = {
      attempts,
      lastError: message,
      lastHeartbeatAt: Timestamp.now(),
    };
    if (attempts >= MAX_ATTEMPTS) {
      update['state'] = 'failed';
    }
    await ledgerRef.update(update);
  }
}
