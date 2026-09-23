/**
 * Completes a deletion for a user stranded by the issue #347 bug (issue #357,
 * "Att göra" item 3 — a targeted repair, not the general sweep).
 *
 * ── Background ───────────────────────────────────────────────────────────
 * `runAccountDeletion` (actions/account.ts) runs in phases:
 *   Step 2 — one `runTransaction` PER COMPANY, committed immediately: deletes
 *     `companies/{cid}/members/{uid}` and applies the memberCounts delta.
 *   Step 3 — a single chunked `WriteBatch`, committed only at the end:
 *     anonymises bookings/equipment/units/invitations, anonymises the
 *     company's Stripe customer, deletes `users/{uid}/memberships/{cid}` for
 *     every company, deletes `users/{uid}`, writes the success
 *     `deletionAuditLog` row.
 *   Step 4 — deletes the Firebase Auth record.
 *
 * #347 made step 3 throw deterministically (a missing Firestore index) for
 * EVERY user, after step 2 had already committed. The result: the company
 * membership is gone, but the user-side pointer, the `users/{uid}` doc, and
 * the Auth record all survive, and no audit row exists at all.
 * `tools/inventory_stranded_deletions.js` (read-only) found exactly one such
 * user in `allocate-alpha`.
 *
 * This script finishes step 3 and step 4 for that user (step 2 is already
 * done — this script never touches `companies/{cid}/members/{uid}` or
 * `_meta/memberCounts`, and re-verifies that step 2's effects are in place
 * before doing anything else).
 *
 * ── What it mirrors, and one deliberate deviation ───────────────────────
 * Per company (from the user's OWN `users/{uid}/memberships` docs, matching
 * `runAccountDeletion` step 3 exactly):
 *   - if `companies/{cid}` has `deletion.mode === 'immediate'` (step 2 would
 *     have written this in the SAME transaction that deleted the member doc,
 *     for a company whose sole remaining member was this user) — skip
 *     anonymisation for that company entirely, exactly like step 3's own
 *     `immediatelyDeletedCompanyIds` skip, because the async purge
 *     (`functions/src/company/purge.ts`) already owns cleanup there,
 *     including its own Stripe handling.
 *   - otherwise: anonymise bookings (userId/cancelledBy/approverId),
 *     equipment (createdBy/approverId), equipment units
 *     (createdBy/updatedBy/deactivatedBy), invitations
 *     (acceptedBy/invitedBy/revokedBy), company.createdBy, and — separately
 *     gated, see below — the Stripe customer.
 * Then, once, not per company: delete every `users/{uid}/memberships/*`
 * pointer, delete `users/{uid}`, write the `deletionAuditLog` success row,
 * delete the Auth record (`auth/user-not-found` tolerated).
 *
 * DEVIATION from step 3: the Stripe customer rename
 * (email -> deleted@allocate.invalid, name -> 'Deleted User') is real
 * production behaviour in account.ts, but it fires unconditionally whenever
 * `stripeCustomerId` is set on the company — it doesn't check whether the
 * user being deleted is the billing contact, or whether other members still
 * depend on that Stripe customer being intact. Run today, months after the
 * fact, against a company that (per the re-verification below) may still
 * have an ACTIVE or TRIALING subscription and other admins, that one-off
 * write is higher-stakes than the same line firing inline during a normal
 * self-service deletion. This script performs it ONLY when `--yes` AND
 * `--confirm-stripe` are BOTH passed; `--yes` alone applies every other
 * write and prints the Stripe action as SKIPPED with a warning. The dry run
 * always shows what it would do.
 *
 * ── Safety ───────────────────────────────────────────────────────────────
 * DRY RUN by default. Nothing is written unless `--yes` is passed. Before
 * doing anything, re-verifies the stranded signature per company
 * (`companies/{cid}` exists, `companies/{cid}/members/{uid}` is missing,
 * `users/{uid}/memberships/{cid}` is present) and aborts the whole run
 * otherwise — this is a targeted repair for a confirmed signature, not a
 * general-purpose deletion tool. Idempotent: every write here is either a
 * query-driven update (nothing left to match once already anonymised, same
 * idempotency property as account.ts itself), a delete (safe to repeat), or
 * an existence-checked insert (the audit row).
 *
 * Never logs or prints a name or email — the uid is truncated to 8 chars
 * + '...' everywhere, matching actions/account.ts's own logging convention.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *   node tools/complete_stranded_deletion_357.js --project=allocate-alpha --uid=<uid>                                     # dry run
 *   node tools/complete_stranded_deletion_357.js --project=allocate-alpha --uid=<uid> --yes                               # apply (Stripe rename skipped + warned)
 *   node tools/complete_stranded_deletion_357.js --project=allocate-alpha --uid=<uid> --yes --confirm-stripe              # apply, including the Stripe rename
 *
 * Credentials: Application Default Credentials only (`gcloud auth
 * application-default login` once) — no service-account fallback, to keep
 * this script's blast radius to exactly the project named on the command
 * line.
 *
 * `--project` is required and MUST equal `allocate-alpha` — this repair was
 * written for the one user inventory found there. Re-running it against a
 * different environment for a different stranded user is a deliberate,
 * separate decision, not a flag away.
 */

'use strict';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const APPLY = flag('yes');
const CONFIRM_STRIPE = flag('confirm-stripe');
const PROJECT = value('project');
const UID = value('uid');

const ALLOWED_PROJECT = 'allocate-alpha';

if (!PROJECT) {
  console.error('ERROR: --project is required.');
  process.exit(1);
}
if (PROJECT !== ALLOWED_PROJECT) {
  console.error(`ERROR: --project must be "${ALLOWED_PROJECT}" (got "${PROJECT}"). This script is scoped to that one confirmed case.`);
  process.exit(1);
}
if (!UID) {
  console.error('ERROR: --uid is required.');
  process.exit(1);
}

const short = (uid) => `${uid.slice(0, 8)}...`;

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { createHash } = require('crypto');

initializeApp({ credential: applicationDefault(), projectId: PROJECT });
const db = getFirestore();
const auth = getAuth();

const BATCH_LIMIT = 490;

console.log(`[complete_stranded_deletion_357] project=${PROJECT} uid=${short(UID)} mode=${APPLY ? 'APPLY' : 'DRY RUN'}${APPLY && !CONFIRM_STRIPE ? ' (Stripe rename will be SKIPPED — pass --confirm-stripe to include it)' : ''}`);

// ── Batch helper (mirrors actions/account.ts's commitAndReset/addOp/addDelete) ──

function makeBatcher() {
  let batch = db.batch();
  let opCount = 0;
  const planned = []; // { kind, path, fields? } — printed regardless of APPLY

  async function flushIfNeeded() {
    if (opCount >= BATCH_LIMIT) {
      if (APPLY) await batch.commit();
      batch = db.batch();
      opCount = 0;
    }
  }

  return {
    planned,
    async update(ref, data) {
      planned.push({ kind: 'update', path: ref.path, fields: Object.keys(data) });
      if (APPLY) batch.update(ref, data);
      opCount++;
      await flushIfNeeded();
    },
    async del(ref) {
      planned.push({ kind: 'delete', path: ref.path });
      if (APPLY) batch.delete(ref);
      opCount++;
      await flushIfNeeded();
    },
    async set(ref, data) {
      planned.push({ kind: 'set', path: ref.path, fields: Object.keys(data) });
      if (APPLY) batch.set(ref, data);
      opCount++;
      await flushIfNeeded();
    },
    async commit() {
      if (APPLY && opCount > 0) await batch.commit();
    },
  };
}

async function main() {
  // ── Re-verify the stranded signature ────────────────────────────────────
  const membershipsSnap = await db.collection(`users/${UID}/memberships`).get();

  if (membershipsSnap.empty) {
    console.log('No users/{uid}/memberships docs found. Either already fully repaired, or this uid was never stranded. Nothing to do.');
    return;
  }

  const companyChecks = [];
  for (const membershipDoc of membershipsSnap.docs) {
    const companyId = membershipDoc.data().companyId;
    if (!companyId) {
      console.error(`ABORT: membership doc ${membershipDoc.ref.path} has no companyId field. Not the expected signature — refusing to proceed.`);
      process.exit(1);
    }
    const companyRef = db.doc(`companies/${companyId}`);
    const memberRef = db.doc(`companies/${companyId}/members/${UID}`);
    const [companySnap, memberSnap] = await Promise.all([companyRef.get(), memberRef.get()]);

    if (!companySnap.exists) {
      console.error(`ABORT: companies/${companyId} does not exist. This is the "stale pointer" bucket from the inventory script's docblock, not the #347 half-deleted signature — a different repair, not this one.`);
      process.exit(1);
    }
    if (memberSnap.exists) {
      console.error(`ABORT: companies/${companyId}/members/${short(UID)} still exists. Step 2 was never applied for this company — this uid does not match the stranded signature this script repairs.`);
      process.exit(1);
    }

    companyChecks.push({ companyId, companyRef, companySnap, memberRef });
    console.log(`Verified stranded signature for company ${companyId}: company exists, member doc missing, membership pointer present.`);
  }

  const batcher = makeBatcher();

  // ── Per-company anonymisation (mirrors step 3's per-company loop) ───────
  for (const { companyId, companyRef, companySnap } of companyChecks) {
    const deletionMode = companySnap.data()?.deletion?.mode;
    if (deletionMode === 'immediate') {
      console.log(`Company ${companyId}: deletion.mode === 'immediate' — step 2 already scheduled this company for purge. Skipping anonymisation for it, exactly like step 3's immediatelyDeletedCompanyIds skip; the purge owns cleanup here.`);
      continue;
    }

    const bookingsRef = db.collection(`companies/${companyId}/bookings`);
    const equipmentRef = db.collection(`companies/${companyId}/equipment`);
    const invitationsRef = db.collection(`companies/${companyId}/invitations`);

    const byUserId = await bookingsRef.where('userId', '==', UID).get();
    for (const d of byUserId.docs) await batcher.update(d.ref, { userId: null, userName: null });

    const byCancelledBy = await bookingsRef.where('cancelledBy', '==', UID).get();
    for (const d of byCancelledBy.docs) await batcher.update(d.ref, { cancelledBy: null });

    const byApproverId = await bookingsRef.where('approverId', '==', UID).get();
    for (const d of byApproverId.docs) await batcher.update(d.ref, { approverId: null });

    const byCreatedBy = await equipmentRef.where('createdBy', '==', UID).get();
    for (const d of byCreatedBy.docs) await batcher.update(d.ref, { createdBy: null });

    const byEquipmentApprover = await equipmentRef.where('approverId', '==', UID).get();
    for (const d of byEquipmentApprover.docs) await batcher.update(d.ref, { approverId: null });

    const allEquipmentSnap = await equipmentRef.get();
    const unitsSnaps = await Promise.all(allEquipmentSnap.docs.map((eqDoc) => eqDoc.ref.collection('units').get()));
    for (const unitsSnap of unitsSnaps) {
      for (const doc of unitsSnap.docs) {
        const data = doc.data();
        const updates = {};
        if (data.createdBy === UID) updates.createdBy = null;
        if (data.updatedBy === UID) updates.updatedBy = null;
        if (data.deactivatedBy === UID) updates.deactivatedBy = null;
        if (Object.keys(updates).length > 0) await batcher.update(doc.ref, updates);
      }
    }

    const byAcceptedBy = await invitationsRef.where('acceptedBy', '==', UID).get();
    for (const d of byAcceptedBy.docs) await batcher.update(d.ref, { email: null, acceptedBy: null });

    const byInvitedBy = await invitationsRef.where('invitedBy', '==', UID).get();
    for (const d of byInvitedBy.docs) await batcher.update(d.ref, { invitedBy: null, invitedByName: null });

    const byRevokedBy = await invitationsRef.where('revokedBy', '==', UID).get();
    for (const d of byRevokedBy.docs) await batcher.update(d.ref, { revokedBy: null });

    // Pending invitations still addressed TO this user cannot be matched
    // safely here: account.ts matches by session.email (the caller's own,
    // freshly-normalised session claim), which this offline script has no
    // equivalent of, and the user's Auth record's email is exactly the PII
    // this run must not print or otherwise handle loosely. None were found
    // for this uid in the pre-flight investigation (this uid is the
    // acceptedBy party, not a pending invitee), so it's a documented gap,
    // not a silent skip of found data.

    if (companySnap.data()?.createdBy === UID) {
      await batcher.update(companyRef, { createdBy: null });
    }

    const stripeCustomerId = companySnap.data()?.stripeCustomerId;
    if (stripeCustomerId) {
      const subStatus = companySnap.data()?.subscription?.status;
      console.log(`Company ${companyId}: stripeCustomerId=${stripeCustomerId} subscription.status=${subStatus ?? '(none)'} — SURPRISING if active/trialing, see script docblock's "deliberate deviation".`);
      if (APPLY && CONFIRM_STRIPE) {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        await stripe.customers.update(stripeCustomerId, {
          email: 'deleted@allocate.invalid',
          name: 'Deleted User',
          metadata: { deletedAt: new Date().toISOString() },
        });
        console.log(`  -> Stripe customer ${stripeCustomerId} renamed to 'Deleted User' / deleted@allocate.invalid.`);
      } else {
        console.log('  -> Stripe rename SKIPPED (pass --yes --confirm-stripe together to include it).');
      }
      if (!subStatus || subStatus === 'canceled') {
        await batcher.update(companyRef, { stripeCustomerId: '' });
      } else {
        console.log(`  -> subscription.status is "${subStatus}", not canceled — company.stripeCustomerId left in place (matches account.ts: only cleared when canceled/absent).`);
      }
    }
  }

  // ── Once, not per company ───────────────────────────────────────────────
  for (const membershipDoc of membershipsSnap.docs) {
    await batcher.del(membershipDoc.ref);
  }
  await batcher.del(db.doc(`users/${UID}`));

  const userIdHash = createHash('sha256').update(UID).digest('hex');
  const existingAudit = await db.collection('deletionAuditLog')
    .where('userIdHash', '==', userIdHash)
    .where('triggeredBy', '==', 'admin_remediation_issue_357')
    .limit(1)
    .get();

  if (existingAudit.empty) {
    await batcher.set(db.collection('deletionAuditLog').doc(), {
      userIdHash,
      deletedAt: FieldValue.serverTimestamp(),
      triggeredBy: 'admin_remediation_issue_357',
      note: 'Retroactive completion of a deletion left half-done by issue #347 (step 3/4 never ran). See issue #357.',
    });
  } else {
    console.log('deletionAuditLog already has a row for this uid from a prior run of this script — not writing a duplicate.');
  }

  await batcher.commit();

  console.log('');
  console.log(`── Planned Firestore operations (${batcher.planned.length}) ${APPLY ? '(APPLIED)' : '(DRY RUN — nothing written)'} ──`);
  const counts = {};
  for (const op of batcher.planned) {
    const label = `${op.kind} ${op.path.replace(new RegExp(UID, 'g'), short(UID))}`;
    console.log(`  ${label}${op.fields ? ` [${op.fields.join(', ')}]` : ''}`);
    const kindKey = op.path.includes('/bookings/') ? 'bookings'
      : op.path.includes('/units') ? 'units'
      : op.path.includes('/equipment/') ? 'equipment'
      : op.path.includes('/invitations/') ? 'invitations'
      : op.path.includes('/memberships/') ? 'memberships'
      : op.path.startsWith('users/') ? 'userDoc'
      : op.path.startsWith('deletionAuditLog') ? 'auditLog'
      : op.path.startsWith('companies/') ? 'companyDoc'
      : 'other';
    counts[kindKey] = (counts[kindKey] || 0) + 1;
  }
  console.log('── Counts by doc type ──');
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);

  // ── Auth record deletion (step 4) — last, irreversible ──────────────────
  if (APPLY) {
    try {
      await auth.deleteUser(UID);
      console.log(`Auth user ${short(UID)} deleted.`);
    } catch (err) {
      if (err && err.code === 'auth/user-not-found') {
        console.log(`Auth user ${short(UID)} already gone (auth/user-not-found) — treated as success, matching account.ts.`);
      } else {
        console.error('Auth deletion failed:', err);
        process.exit(1);
      }
    }
  } else {
    console.log(`DRY RUN: would delete Auth user ${short(UID)} (auth/user-not-found tolerated).`);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
