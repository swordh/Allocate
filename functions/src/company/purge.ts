import { FieldValue, GrpcStatus, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import type { CompanyDeletionDocument, CompanyDeletionPhase } from '../types';
import { cleanupOneMember } from './memberCleanup';
import { getStripeClient } from './stripeClient';
import { formatDateFull, formatRequesterDisplay } from './format';
import { appUrl } from '../appUrl';
import { applyFailedTransition } from './failDeletion';

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

/**
 * Thrown by `markPhaseComplete` when the ledger it just re-read is no longer
 * `executing` — an operator marked it `failed` (or requeued it, or something
 * else changed its state) WHILE this phase was running. `runCompanyPurge`'s
 * catch block special-cases this: an aborted run is not a failure of the
 * phase itself, so it must never burn an `attempts` slot or overwrite
 * whatever the concurrent writer just set. See markPhaseComplete's own
 * docblock and the "Liveness guard" section of the #331/#335 plan.
 */
export class PurgeAbortedError extends Error {
  constructor(requestId: string, state: string) {
    super(`purge aborted: companyDeletions/${requestId} is '${state}', not 'executing'`);
    this.name = 'PurgeAbortedError';
  }
}

/**
 * How many BulkWriter results the subtree phase lets go by between
 * heartbeats. `recursiveDelete` can produce thousands of individual deletes
 * for a company with a large `bookings` collection with no natural
 * per-collection checkpoint in between (unlike every other phase, which
 * heartbeats per batch/uid/chunk already) — this is what makes THAT
 * collection, specifically, look dead to the sweep's stale-lease detection
 * despite being mid-flight. 500 matches this file's own `BATCH_LIMIT` — not
 * load-bearing, just a familiar-sized cadence.
 */
const SUBTREE_HEARTBEAT_INTERVAL = 500;

/**
 * Review fix: a count-only threshold can starve on SLOW deletes — 499
 * documents whose individual deletes each take a few seconds (large
 * documents, a throttled BulkWriter backing off after transient errors) can
 * sit well past the 60-minute stale-lease window without ever reaching the
 * 500th write, producing a FALSE `no_progress` failure on a purge that is
 * genuinely still working. Whichever bound is hit FIRST wins: 500 writes, or
 * 30 seconds elapsed since the last heartbeat with at least one write
 * completed in that window (a genuinely stalled BulkWriter — zero writes
 * completing at all — still can't heartbeat on its own; nothing can bump a
 * value from inside a callback that never fires. That residual case is what
 * `claimStaleLease`'s no-progress detection exists for in the first place).
 */
const SUBTREE_HEARTBEAT_MAX_INTERVAL_MS = 30_000;

// ── Phase 1: Stripe ───────────────────────────────────────────────────────────

/**
 * Cancels the subscription without proration and anonymises (never deletes)
 * the Stripe customer — invoices survive for Bokföringslagen's seven years,
 * same trade-off `runAccountDeletion`'s own Stripe billing-contact
 * anonymisation (actions/account.ts, step 3's Stripe block) makes for a
 * user's own account deletion. Best-effort and non-fatal by design: a company must
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
async function runInvitationsPhase(
  db: Firestore,
  companyId: string,
  ledgerRef: FirebaseFirestore.DocumentReference,
): Promise<void> {
  const invitationsSnap = await db.collection(`companies/${companyId}/invitations`).get();

  let batch = db.batch();
  let opCount = 0;
  for (const doc of invitationsSnap.docs) {
    const token = doc.data()['token'] as string | undefined;
    if (!token) continue;
    batch.delete(db.doc(`invitations/${token}`));
    opCount++;
    if (opCount >= BATCH_LIMIT) {
      // Progress bump lands in the SAME batch as the deletes it describes —
      // see the docblock on `CompanyDeletionDocument.progressUnits` in
      // types.ts: a batch that commits at all means real work happened, so
      // there is no crash window where the bump could land without the
      // deletes, or vice versa. `lastHeartbeatAt` rides along in the SAME
      // write for the same reason (review fix, issue #331/#335 follow-up):
      // `progressUnits` alone only resets `claimStaleLease`'s no-progress
      // COUNTER at the next stale-lease check, it does not by itself stop
      // the row from being *found* stale in the first place — a phase with
      // enough invitations to need >1 batch, each batch slower than the
      // 60-minute stale-lease window, would otherwise look dead to
      // `resumeStuck` between batches even though `progressUnits` is moving.
      batch.update(ledgerRef, { progressUnits: FieldValue.increment(1), lastHeartbeatAt: Timestamp.now() });
      batch = await commitAndReset(db, batch);
      opCount = 0;
    }
  }
  if (opCount > 0) {
    batch.update(ledgerRef, { progressUnits: FieldValue.increment(1), lastHeartbeatAt: Timestamp.now() });
    await batch.commit();
  }
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

    await ledgerRef.update({
      formerMemberContacts: contacts,
      lastHeartbeatAt: Timestamp.now(),
      progressUnits: FieldValue.increment(1),
    });
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
  // One BulkWriter shared across every collection in this phase (not a fresh
  // one per collection) so the 500-write heartbeat cadence below counts
  // across the whole phase, not per collection — a company with 400 pieces
  // of equipment and 400 bookings should heartbeat around 800 deletes in,
  // not never (200 into each collection separately would never hit 500).
  const bulkWriter = db.bulkWriter();
  let sinceLastHeartbeat = 0;
  let lastHeartbeatWallClockMs = Date.now();
  // Firestore's own read-then-write ordering doesn't apply here — this is a
  // bare `.update()` call, not a transaction — but the writes still have to
  // be SERIALIZED among themselves, or two `onWriteResult` callbacks firing
  // close together could both read a stale `progressUnits` and race each
  // other. `FieldValue.increment` sidesteps the read entirely (the server
  // does the arithmetic), so this chain exists only to keep calls in order
  // and to give the phase something to `await` before it returns —
  // `onWriteResult` itself is synchronous and cannot be awaited directly.
  let heartbeatChain: Promise<unknown> = Promise.resolve();

  bulkWriter.onWriteResult(() => {
    sinceLastHeartbeat++;
    // Whichever bound is hit first — see SUBTREE_HEARTBEAT_MAX_INTERVAL_MS's
    // own docblock for why the wall-clock bound exists alongside the count.
    const elapsedMs = Date.now() - lastHeartbeatWallClockMs;
    if (sinceLastHeartbeat < SUBTREE_HEARTBEAT_INTERVAL && elapsedMs < SUBTREE_HEARTBEAT_MAX_INTERVAL_MS) return;
    sinceLastHeartbeat = 0;
    lastHeartbeatWallClockMs = Date.now();
    heartbeatChain = heartbeatChain.then(() =>
      ledgerRef.update({ progressUnits: FieldValue.increment(1), lastHeartbeatAt: Timestamp.now() }),
    );
  });

  // Logs which document failed and how many times, without any of its
  // DATA — a document path under `companies/{cid}/...` carries no PII by
  // itself (uids and Stripe ids are never part of a path in this schema),
  // unlike the field values a delete's error could otherwise be tempted to
  // include. Returns exactly the PUBLICLY DOCUMENTED default retry policy
  // (`BulkWriter.onWriteError`'s own doc comment: "retries UNAVAILABLE and
  // ABORTED errors up to a maximum of 10 failed attempts") — setting a
  // handler at all REPLACES BulkWriter's internal default outright, so
  // logging here would otherwise silently also change what gets retried.
  const MAX_DELETE_RETRY_ATTEMPTS = 10;
  bulkWriter.onWriteError((error) => {
    const shouldRetry =
      (error.code === GrpcStatus.UNAVAILABLE || error.code === GrpcStatus.ABORTED) &&
      error.failedAttempts < MAX_DELETE_RETRY_ATTEMPTS;
    logger.warn('runCompanyPurge: subtree delete failed', {
      companyId,
      path: error.documentRef.path,
      code: error.code,
      failedAttempts: error.failedAttempts,
      willRetry: shouldRetry,
    });
    return shouldRetry;
  });

  for (const name of SUBTREE_COLLECTIONS) {
    const ref = db.collection(`companies/${companyId}/${name}`);
    await db.recursiveDelete(ref, bulkWriter);
    await ledgerRef.update({
      [`phaseCounts.subtree_${name}`]: 1,
      lastHeartbeatAt: Timestamp.now(),
      progressUnits: FieldValue.increment(1),
    });
  }

  // `recursiveDelete` never closes a BulkWriter we hand it — that's on us,
  // and it must happen before we await the heartbeat chain, since a queued
  // write only ever settles once the writer is closed (or flushed).
  await bulkWriter.close();
  await heartbeatChain;
}

// ── Phase 5: orphans ─────────────────────────────────────────────────────────────

/**
 * Documents that reference the company via a denormalized `companyId` field
 * but live at the top level, outside `companies/{cid}` entirely — so
 * `recursiveDelete` never reaches them. Found by query, deleted with the
 * chunked-`WriteBatch` house pattern.
 */
async function runOrphansPhase(
  db: Firestore,
  companyId: string,
  ledgerRef: FirebaseFirestore.DocumentReference,
): Promise<void> {
  for (const name of ORPHAN_COLLECTIONS) {
    const snap = await db.collection(name).where('companyId', '==', companyId).get();
    let batch = db.batch();
    let opCount = 0;
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
      opCount++;
      if (opCount >= BATCH_LIMIT) {
        // lastHeartbeatAt alongside progressUnits — same review fix as
        // runInvitationsPhase above, same reason: a batch commit is real
        // work, and the heartbeat must say so in the same write.
        batch.update(ledgerRef, { progressUnits: FieldValue.increment(1), lastHeartbeatAt: Timestamp.now() });
        batch = await commitAndReset(db, batch);
        opCount = 0;
      }
    }
    if (opCount > 0) {
      batch.update(ledgerRef, { progressUnits: FieldValue.increment(1), lastHeartbeatAt: Timestamp.now() });
      await batch.commit();
    }
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
  // Snapshot taken at request time (issue #361) — see the doc comment on
  // `CompanyDeletionDocument.timezone` in functions/src/types.ts. This is
  // the ONE phase that must not re-read the company document for it: by the
  // time finalize runs, the company doc a few lines below is about to be
  // deleted, and a resumed finalize can run again after that delete already
  // committed — there is nothing left to read a live preference from.
  const timezone = ledger.timezone ?? 'UTC';
  const deletedAtFormatted = formatDateFull(Timestamp.now(), timezone);
  const requestedAtFormatted = formatDateFull(ledger.requestedAt, timezone);
  // Issue #334 — same display rule as every other deletion-lifecycle mail.
  const requestedByDisplay = formatRequesterDisplay(ledger.requestSource, ledger.requestedByName);

  const pending = contacts.filter((c) => c.email && !mailedUids.has(c.uid));

  let batch = db.batch();
  let opCount = 0;
  let mailedThisChunk: string[] = [];

  async function commitChunk(): Promise<void> {
    if (opCount === 0) return;
    const updated = Array.from(new Set([...mailedUids, ...mailedThisChunk]));
    // lastHeartbeatAt alongside progressUnits — review fix (issue #331/#335
    // follow-up). A company with enough former members to need several mail
    // chunks can legitimately take over an hour to finalize; without this,
    // `progressUnits` moving would only reset `claimStaleLease`'s counter at
    // its NEXT check, but the row could already have been found "stale" and
    // resumed a second time in the meantime — the exact duplicate-purge risk
    // finalize's in-memory `mailedUids` tracking cannot defend against on
    // its own (it is not transactional across two concurrent invocations).
    batch.update(ledgerRef, {
      finalizeMailQueuedUids: updated,
      progressUnits: FieldValue.increment(1),
      lastHeartbeatAt: Timestamp.now(),
    });
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
        ? appUrl('/signup')
        : contact.accountStatus === 'scheduled'
          ? appUrl('/login')
          : appUrl('/company/new');

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
        requestedByName: requestedByDisplay,
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
        // Formatted in the SAME company-zone snapshot as every other date on
        // this mail (issue #361) — never the runtime's own zone.
        ...(contact.pendingDeletionScheduledFor
          ? { pendingDeletionScheduledForFormatted: formatDateFull(contact.pendingDeletionScheduledFor, timezone) }
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

/**
 * Marks one phase complete AND is the liveness guard for the whole purge
 * (issue #331/#335's "Liveness guard" section): a transaction, not a plain
 * `.update()`, because it re-reads the ledger's CURRENT state immediately
 * before writing and refuses to proceed if something else has moved it away
 * from `executing` since this invocation of `runCompanyPurge` started —
 * most concretely, an operator's "mark as failed" action (the Next-side
 * twin of `applyFailedTransition`) landing WHILE this phase was still
 * running. Without this check, the phase that was in flight when the
 * operator acted would finish moments later and cheerfully mark itself
 * complete on a row the operator just told the system to stop touching,
 * potentially racing that operator write's own effects (Stripe already
 * cancelled, contacts already partly redacted).
 *
 * Throws `PurgeAbortedError` rather than returning a sentinel — this needs
 * to unwind out of whichever phase function called it, exactly the way an
 * ordinary phase failure does, and `runCompanyPurge`'s catch block already
 * has to special-case `PurgeAbortedError` regardless (see there for why:
 * an aborted run must never burn an `attempts` slot).
 */
async function markPhaseComplete(
  db: Firestore,
  ledgerRef: FirebaseFirestore.DocumentReference,
  requestId: string,
  phase: CompanyDeletionPhase,
  completed: Set<CompanyDeletionPhase>,
): Promise<void> {
  completed.add(phase);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ledgerRef);
    const state = snap.exists ? (snap.data() as CompanyDeletionDocument).state : undefined;
    if (state !== 'executing') {
      throw new PurgeAbortedError(requestId, state ?? 'missing');
    }
    tx.update(ledgerRef, {
      phase,
      completedPhases: Array.from(completed),
      progressUnits: FieldValue.increment(1),
      lastHeartbeatAt: Timestamp.now(),
    });
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
 *
 * LIVENESS GUARD (issue #331/#335): before running anything, this function
 * now refuses to act on a ledger that isn't `state: 'executing'` — a plain
 * early return, no error. Two production paths can reach this in a
 * non-`executing` state that used to be silently tolerated: `resumeStuck`
 * (sweep.ts) calling this after `claimStaleLease` already declared the row
 * `'failed'` inside the SAME check (defensively redundant with the
 * `outcome === 'failed'` skip added there, but this function must be safe to
 * call directly too, since it's exported and used that way by every emulator
 * test in this file), and an operator's "mark as failed" action landing
 * between a caller's lease claim and its call to `runCompanyPurge`. Every
 * phase boundary ALSO re-checks this via `markPhaseComplete`'s own
 * transaction, which is what catches the state changing mid-phase rather
 * than only at the very start.
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

  if (ledger.state !== 'executing') {
    logger.info('runCompanyPurge: ledger is not executing, nothing to do', {
      requestId,
      companyId,
      state: ledger.state,
    });
    return;
  }

  const completed = new Set<CompanyDeletionPhase>(ledger.completedPhases ?? []);

  try {
    if (!completed.has('stripe')) {
      await runStripePhase(db, companyId);
      await markPhaseComplete(db, ledgerRef, requestId, 'stripe', completed);
    }

    if (!completed.has('invitations')) {
      await runInvitationsPhase(db, companyId, ledgerRef);
      await markPhaseComplete(db, ledgerRef, requestId, 'invitations', completed);
    }

    let contacts = ledger.formerMemberContacts ?? [];
    if (!completed.has('members')) {
      contacts = await runMembersPhase(db, companyId, requestId, ledgerRef, contacts);
      await markPhaseComplete(db, ledgerRef, requestId, 'members', completed);
    }

    if (!completed.has('subtree')) {
      await runSubtreePhase(db, companyId, ledgerRef);
      await markPhaseComplete(db, ledgerRef, requestId, 'subtree', completed);
    }

    if (!completed.has('orphans')) {
      await runOrphansPhase(db, companyId, ledgerRef);
      await markPhaseComplete(db, ledgerRef, requestId, 'orphans', completed);
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

    // A TRANSACTION, not a plain `.update()` — issue #331/#335's liveness
    // guard means a phase can fail for a reason that has NOTHING to do with
    // this purge's own attempts budget: `PurgeAbortedError` (or the ledger
    // simply no longer being `executing` by the time this runs, which is
    // the same situation observed a different way). Re-reading here, inside
    // the transaction, rather than trusting the `ledger`/`companyId`
    // variables captured at the top of this function is what makes this
    // correct even when the abort happened AFTER those were read.
    await db.runTransaction(async (tx) => {
      const currentSnap = await tx.get(ledgerRef);
      if (!currentSnap.exists) {
        logger.error('runCompanyPurge: ledger disappeared before the failure could be recorded', {
          requestId,
          companyId,
          error: message,
        });
        return;
      }
      const current = currentSnap.data() as CompanyDeletionDocument;

      if (err instanceof PurgeAbortedError || current.state !== 'executing') {
        // Not this run's failure to record — something else already moved
        // the row on. Leaving `attempts`/`lastError` untouched is the whole
        // point: an operator's "mark as failed" (or a requeue, or a second
        // concurrent invocation somehow reaching 'completed' first) must
        // never be clobbered by a stale error from a run that lost the
        // race.
        logger.warn('runCompanyPurge: aborted — ledger state changed away from executing during this run, leaving attempts untouched', {
          requestId,
          companyId,
          state: current.state,
          error: message,
        });
        return;
      }

      const attempts = (current.attempts ?? 0) + 1;
      const willExhaustBudget = attempts >= MAX_ATTEMPTS;

      // Reads before writes, Firestore transaction rule: everything
      // `applyFailedTransition` needs is fetched here, BEFORE the
      // `tx.update` below, even though it's only used if the budget is
      // exhausted.
      let companySnap: FirebaseFirestore.DocumentSnapshot | null = null;
      let adminsSnap: FirebaseFirestore.QuerySnapshot | null = null;
      if (willExhaustBudget) {
        companySnap = await tx.get(db.doc(`companies/${companyId}`));
        adminsSnap = await tx.get(db.collection(`companies/${companyId}/members`).where('role', '==', 'admin'));
      }

      logger.error('runCompanyPurge: phase failed', { requestId, companyId, attempts, error: message });

      const now = Timestamp.now();
      tx.update(ledgerRef, {
        attempts,
        lastError: message,
        lastHeartbeatAt: now,
      });

      if (willExhaustBudget) {
        applyFailedTransition(tx, {
          db,
          ledgerRef,
          ledger: { ...current, attempts },
          companySnap,
          adminsSnap,
          reason: 'attempts_exhausted',
          now,
        });
      }
    });
  }
}
