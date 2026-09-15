import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
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
 *
 * MAINTENANCE: nothing in the codebase enforces that this list stays
 * complete. Any FUTURE top-level collection that gets a `companyId` field
 * (a new operator- or billing-side collection, say) needs to be added here
 * by hand, or the purge will silently leave its rows behind for a deleted
 * company — there is no compiler error, no test failure, and no runtime
 * warning for "a collection with companyId exists that this list doesn't
 * know about". Check this list whenever you add a new collection with a
 * denormalized `companyId`.
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
 * returns successfully AND reports `claimsUpdated: true`, and the ledger is
 * updated before the next uid starts — so a crash mid-list resumes by
 * skipping every uid already present, never redoing committed work. See the
 * field's doc comment in types/company.ts.
 *
 * A uid whose claims update failed is deliberately left OUT of `contacts` —
 * `cleanupOneMember`'s idempotency guard on its "stranded" branch (see that
 * function's docblock) makes it safe to call again for her specifically on
 * the next resume, rather than either silently leaving her Auth claims
 * pointed at a company that no longer exists, or treating "members" as done
 * while she was never fully processed. This function THROWS if any member
 * had a claims failure this pass, instead of returning normally — that's
 * what stops `runCompanyPurge` from marking the 'members' phase complete,
 * and routes the failure through the normal attempts/lastError machinery so
 * it's visible to the sweep's stuck/failed handling rather than silently
 * retried forever with no operator-visible signal.
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
  let hadClaimsFailure = false;

  for (const doc of membersSnap.docs) {
    const uid = doc.id;
    if (done.has(uid)) continue;

    const data = doc.data();
    const outcome = await cleanupOneMember(db, companyId, uid, requestId);

    if (!outcome.claimsUpdated) {
      hadClaimsFailure = true;
      logger.error('runMembersPhase: claims update failed, uid will be retried on resume', {
        uid: uid.slice(0, 8) + '...',
        companyId,
        requestId,
      });
      continue; // not added to contacts — see docblock
    }

    contacts.push({
      uid,
      name: (data['name'] as string | undefined) ?? '',
      email: (data['email'] as string | undefined) ?? '',
      accountStatus: outcome.accountStatus,
      ...(outcome.pendingDeletionScheduledFor
        ? { pendingDeletionScheduledFor: outcome.pendingDeletionScheduledFor }
        : {}),
    });
    done.add(uid);

    await ledgerRef.update({ formerMemberContacts: contacts, lastHeartbeatAt: Timestamp.now() });
  }

  if (hadClaimsFailure) {
    // Still persist whatever DID succeed this pass before throwing — the
    // per-uid writes above already committed one at a time, so this is
    // belt-and-suspenders, not load-bearing.
    await ledgerRef.update({ formerMemberContacts: contacts, lastHeartbeatAt: Timestamp.now() });
    throw new Error('runMembersPhase: one or more members had a claims update failure');
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
 *
 * IDEMPOTENT ACROSS A CRASH — this is the one phase `runCompanyPurge`'s
 * outer `completed.has('finalize')` check can't protect on its own, because
 * "queue mail" → "delete company" → "mark completed" spans three separate
 * writes and a crash between the first and the third would otherwise resume
 * by re-running the whole phase — including re-queuing `companyDeleted` to
 * every former member a second time. That mail's own docblock in
 * mailDelivery.ts calls it the last message a member whose account is gone
 * will ever get from us; a duplicate is not a cosmetic bug.
 *
 * The fix is `ledger.finalizeMailQueuedUids`: each contact's uid is added to
 * it in the SAME `WriteBatch.commit()` as her `mail/{id}` doc, so "her mail
 * doc exists" and "she's recorded as mailed" can never observably disagree
 * — one commits, or neither does. On resume, contacts already in that list
 * are skipped, so a crash between mail-queuing and the company-doc delete
 * (or between that and `state: 'completed'`) resumes into a no-op mail step
 * followed by an idempotent delete (deleting an already-gone doc is a
 * no-op) and an idempotent ledger update (re-writing the same `completed`
 * state is harmless).
 */
async function runFinalizePhase(
  db: Firestore,
  requestId: string,
  companyId: string,
  ledger: CompanyDeletionDocument,
): Promise<void> {
  const ledgerRef = db.collection('companyDeletions').doc(requestId);
  const contacts = ledger.formerMemberContacts ?? [];
  let mailedUids = new Set(ledger.finalizeMailQueuedUids ?? []);
  const deletedAtFormatted = formatDateFull(Timestamp.now());
  const requestedAtFormatted = formatDateFull(ledger.requestedAt);

  const pending = contacts.filter((c) => c.email && !mailedUids.has(c.uid));

  let batch = db.batch();
  let opCount = 0;
  let mailedThisChunk: string[] = [];

  async function commitChunk(): Promise<void> {
    if (opCount === 0) return;
    const updated = Array.from(new Set([...mailedUids, ...mailedThisChunk]));
    batch.update(ledgerRef, { finalizeMailQueuedUids: updated });
    await batch.commit();
    mailedUids = new Set(updated);
    batch = db.batch();
    opCount = 0;
    mailedThisChunk = [];
  }

  for (const contact of pending) {
    // Three distinct destinations, one per accountStatus — see
    // CompanyDeletedData.ctaUrl's docblock in the template. 'scheduled'
    // gets a sign-in URL, not signup: her account still exists.
    const ctaUrl =
      contact.accountStatus === 'already_gone'
        ? 'https://allocate.at/signup'
        : contact.accountStatus === 'scheduled'
          ? 'https://allocate.at/login'
          : 'https://allocate.at/company/new';

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
        // `requestedByName` is `string | null` — null once the 24-month
        // retention job has redacted the row (purgeLogs.ts). Unreachable
        // here in practice (redaction happens two years after the request,
        // on a row that reached a terminal state within days), but the
        // failure mode if it ever were reached is an email that literally
        // says "null asked for ... to be deleted", so it takes a stance
        // rather than a cast. Same fallback wording as
        // lib/subscription-state.ts and CancelDeletionView.
        requestedByName: ledger.requestedByName ?? 'An administrator',
        requestedAtFormatted,
        deletedAtFormatted,
        mode: ledger.mode,
        accountStatus: contact.accountStatus,
        // Never invented here — always the exact timestamp cleanupOneMember
        // wrote onto users/{uid}.pendingDeletion, copied into the ledger's
        // formerMemberContacts by runMembersPhase. Only meaningful (and
        // only read by the template) when accountStatus === 'scheduled'.
        // Omitted entirely rather than `undefined` — Firestore's Admin SDK
        // rejects `undefined` field values by default (no
        // ignoreUndefinedProperties configured anywhere in this codebase).
        ...(contact.pendingDeletionScheduledFor
          ? { pendingDeletionScheduledForFormatted: formatDateFull(contact.pendingDeletionScheduledFor) }
          : {}),
        ctaUrl,
      },
    });
    mailedThisChunk.push(contact.uid);
    opCount++;
    if (opCount >= BATCH_LIMIT) {
      await commitChunk();
    }
  }
  await commitChunk();

  // No tombstone — see "Verkställd radering raderar företagsdokumentet" in
  // the plan: a leftover shell would keep showing up in the operator
  // customer list, match the webhook's customer search, and keep the
  // per-member read rule alive for a session running on stale claims.
  // Idempotent: deleting an already-deleted doc is a no-op, so a resumed
  // finalize that reaches this line again after the delete already
  // committed does not error.
  await db.doc(`companies/${companyId}`).delete();

  await ledgerRef.update({
    state: 'completed',
    completedAt: Timestamp.now(),
    lastHeartbeatAt: Timestamp.now(),
    // A purge that succeeded has no use for the exception text of an earlier
    // attempt, and that text is uncapped free-form data that routinely quotes
    // uids, email addresses and Stripe customer ids out of raw Auth/Stripe/
    // Firestore errors. Removed rather than nulled: on a successful row the
    // honest statement is "there is no error here", not "an error was
    // redacted" (see the null-vs-delete rationale in purgeLogs.ts). Safe
    // against the resume machinery — `lastError` is written by the catch
    // block and read by nothing that decides control flow.
    lastError: FieldValue.delete(),
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
 * step 6's "stuck" operator view will hang off of. Does not rethrow: a failed
 * phase is RECORDED, not crashed out of, so the sweep's stuck-lease pass can
 * pick the purge up again rather than relying on Cloud Functions' infra-level
 * retry (which has no idea what a "phase" is).
 *
 * CORRECTION to what this comment used to claim: that only holds while the
 * row is still `executing`. `resumeStuck` (sweep.ts) queries `state ==
 * 'executing'` and `claimStaleLease` (lease.ts) refuses anything else, so
 * once `attempts` hits `MAX_ATTEMPTS` and the state becomes `failed`,
 * NOTHING retries it. `failed` is terminal, and waits for a human.
 *
 * That terminality is load-bearing elsewhere: the contacts retention rule in
 * company/purgeLogs.ts redacts a failed row's `formerMemberContacts` — the
 * members phase's own resume marker — 90 days after its last heartbeat,
 * which is only safe because no code path can resume it. Adding failed-retry
 * to the sweep means dealing with that rule in the same change.
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

  // Diagnostic only — NOT part of the attempts/failed budget. A 540s
  // function timeout SIGKILLs this process mid-phase with no chance to run
  // the catch block below, so `attempts` never increments for that death —
  // the sweep's resumeStuck pass just calls this again from wherever
  // completedPhases last got checkpointed to. That can repeat forever with
  // no operator-visible signal if the SAME phase keeps timing out. This
  // compares this invocation's starting phase count against the previous
  // invocation's (persisted on the ledger, so it survives a SIGKILL) and
  // logs — nothing else — when they match, i.e. this resume made zero
  // progress last time. Left as a log line deliberately: folding this into
  // the attempts counter is a real design decision (does a timeout count
  // the same as a thrown error?) that shouldn't be made as a side effect of
  // adding visibility.
  const lastResumePhaseCount = ledger.lastResumePhaseCount;
  if (lastResumePhaseCount !== undefined && lastResumePhaseCount === completed.size) {
    logger.warn('runCompanyPurge: resumed with the same completedPhases count as last time — possible timed-out attempt making no progress', {
      requestId,
      companyId,
      phaseCount: completed.size,
    });
  }
  await ledgerRef.update({ lastResumePhaseCount: completed.size });

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
