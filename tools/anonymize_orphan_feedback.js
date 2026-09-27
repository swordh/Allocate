/**
 * One-off backfill: nulls `submittedBy`/`userName` on orphaned
 * `operatorFeedback/{ticketId}` docs (issue #338 PR 1).
 *
 * Background: `actions/submitFeedback.ts` stamps a support ticket with the
 * submitter's uid (`submittedBy`) and display name (`userName`). Before this
 * PR's fix, nothing anonymised those fields when the submitter left the
 * company or deleted her account entirely — her name sat in clear text on a
 * top-level support ticket, readable by any operator, for as long as the
 * company that owns it exists. `actions/team.ts`'s `anonymizeMemberReferences`
 * (removeMember/leaveCompany) and `actions/account.ts`'s `deleteAccount` now
 * both null these fields going forward. This script closes the gap for
 * tickets that predate the fix.
 *
 * ── What counts as an orphan ─────────────────────────────────────────────
 * A ticket whose `submittedBy` is set (non-null) AND EITHER:
 *   - `users/{submittedBy}` does not exist (she deleted her account), OR
 *   - `companies/{companyId}/members/{submittedBy}` does not exist (she left
 *     or was removed from the company the ticket was filed in, but her
 *     account itself is otherwise fine).
 *
 * Both checks are plain Firestore existence reads — deliberately NOT a check
 * against Firebase Auth (`adminAuth.getUser`). Firestore is authoritative
 * here for the same reason `tools/cleanup_orphan_members.js` only ever reads
 * `users/{uid}`, never Auth: both `deleteAccount` (actions/account.ts) and
 * the stranded-account sweep (functions/src/company/strandedAccountSweep.ts)
 * delete the Firestore `users/{uid}` doc as part of, or before, deleting the
 * Auth record — so a missing `users/{uid}` doc already implies the account
 * is gone or on its way out, without an extra network round-trip per ticket
 * to the Auth Admin API. The one case Firestore-only misses — an Auth record
 * deleted (e.g. by a manual console action) while `users/{uid}` somehow
 * survives — is not a state either deleteAccount or the sweep can produce, so
 * it isn't worth the extra cost of checking Auth for every ticket in every
 * environment this script runs against.
 *
 * ── Safety window: none needed ───────────────────────────────────────────
 * `cleanup_orphan_members.js` needs a 15-minute safety window because
 * `acceptInvitationByToken` creates a `companies/{cid}/members/{uid}` doc
 * before it creates `users/{uid}`, so a brand-new signup can look like an
 * orphan for a moment. Nothing here writes a ticket's `submittedBy` before
 * either referenced doc exists — `submitFeedback.ts` only ever points at a
 * uid that is already, at that moment, both a `users/{uid}` doc and a member
 * of the company she's filing the ticket from — so no equivalent race exists
 * and no safety window is needed.
 *
 * ── Description/free-text is NOT touched ─────────────────────────────────
 * A ticket's `title`/`description` can itself contain PII the submitter
 * typed in (her own name, an email, anything). This script — like the two
 * production fixes it backfills — only nulls the two STRUCTURED fields
 * (`submittedBy`, `userName`). The free-text problem is a retention question
 * (see issue #338's #295 thread: a fixed retention period for closed tickets,
 * in the style of `purgeOldAuditLogs`), not something field-nulling can fix,
 * and is explicitly out of scope for this script.
 *
 * Usage, from the repo root:
 *   node tools/anonymize_orphan_feedback.js --project=allocate-alpha             # dry run
 *   node tools/anonymize_orphan_feedback.js --project=allocate-alpha --yes       # apply
 *   node tools/anonymize_orphan_feedback.js --project=allocate-beta             # dry run
 *   node tools/anonymize_orphan_feedback.js --project=allocate-beta --yes       # apply
 *   node tools/anonymize_orphan_feedback.js --project=allocate-e0735            # dry run (prod)
 *   node tools/anonymize_orphan_feedback.js --project=allocate-e0735 --yes      # apply (prod)
 *
 *   node tools/anonymize_orphan_feedback.js --project=allocate-alpha --show-pii  # unmasked
 *
 * PII is masked by default in every table this script prints (ticket id's
 * submitter uid, userName — see tools/lib/mask_pii.js). Pass --show-pii to
 * print full values instead. Ticket id and company id/name are never masked
 * either way — a ticket id (e.g. "BUG-4821") is not personal data, and
 * company id/name are the same non-personal exception cleanup_orphan_members.js
 * already makes.
 *
 * Runbook for --show-pii: same rule as cleanup_orphan_members.js — don't save
 * this output to a file or paste it into a CI artifact. Agents run this
 * script masked, always; never pass --show-pii from an agent session, on any
 * environment.
 *
 * Credentials, in resolution order (identical to cleanup_orphan_members.js):
 *   --project=<id>  Application Default Credentials. Preferred.
 *   --sa=<path>     an explicit service account key file.
 *   neither         FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON from .env.local.
 *
 * --dry-run is the DEFAULT. Nothing is written unless --yes is passed.
 * The script is idempotent: a ticket already anonymised (submittedBy already
 * null) is never a candidate — the orphan check only ever looks at tickets
 * where `submittedBy` is still set.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { maskId, maskName } = require('./lib/mask_pii');

// ── Arguments ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const APPLY = flag('yes');
const SA_PATH = value('sa');
const PROJECT = value('project');
const SHOW_PII = flag('show-pii');
const PAGE_SIZE = 200;
const UPDATE_BATCH_LIMIT = 490;

// ── Credentials ──────────────────────────────────────────────────────────────

function readServiceAccountFile(p) {
  const resolved = path.resolve(p);
  if (!fs.existsSync(resolved)) {
    console.error(`ERROR: service account file not found: ${resolved}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function readServiceAccountFromEnv() {
  const envPath = path.resolve(__dirname, '../.env.local');
  if (!fs.existsSync(envPath)) {
    console.error('ERROR: no --project or --sa given, and .env.local not found.');
    process.exit(1);
  }

  const vars = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }

  const raw = vars['FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON'];
  if (!raw) {
    console.error('ERROR: FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON not found in .env.local');
    process.exit(1);
  }
  return JSON.parse(raw);
}

const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

if (PROJECT && SA_PATH) {
  console.error('ERROR: pass either --project or --sa, not both.');
  process.exit(1);
}

let projectId;
let credentialSource;

if (PROJECT) {
  projectId = PROJECT;
  credentialSource = 'application default credentials';
  initializeApp({ credential: applicationDefault(), projectId });
} else {
  const serviceAccount = SA_PATH ? readServiceAccountFile(SA_PATH) : readServiceAccountFromEnv();
  projectId = serviceAccount.project_id;
  credentialSource = SA_PATH ? `service account file ${SA_PATH}` : 'service account from .env.local';
  initializeApp({ credential: cert(serviceAccount) });
}

const db = getFirestore();

// ── Enumeration ──────────────────────────────────────────────────────────────

/**
 * Pages through `operatorFeedback` ordered by `__name__`, yielding only docs
 * whose `submittedBy` is a non-null, non-empty value — an already-anonymised
 * ticket (submittedBy already null, whether from the production fix or an
 * earlier run of this script) is filtered out up front rather than fetched
 * in full and rejected later.
 */
async function* candidateTickets() {
  let cursor = null;
  for (;;) {
    let q = db.collection('operatorFeedback').orderBy('__name__').limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    for (const doc of snap.docs) {
      const data = doc.data();
      if (data.submittedBy) yield { doc, data };
    }
    if (snap.size < PAGE_SIZE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

/**
 * Classifies one candidate ticket as an orphan or not, per the module
 * docblock's "What counts as an orphan" section. Both existence checks run
 * concurrently — they're independent reads.
 */
async function classifyTicket({ doc, data }) {
  const uid = data.submittedBy;
  const companyId = data.companyId;

  const [userSnap, memberSnap] = await Promise.all([
    db.collection('users').doc(uid).get(),
    companyId
      ? db.collection(`companies/${companyId}/members`).doc(uid).get()
      : Promise.resolve({ exists: false }),
  ]);

  const orphan = !userSnap.exists || !memberSnap.exists;
  if (!orphan) return null;

  return {
    ticketId: doc.id,
    ref: doc.ref,
    submittedBy: uid,
    userName: data.userName ?? null,
    companyId: companyId ?? null,
    companyName: data.companyName ?? null,
    reason: !userSnap.exists ? 'account deleted' : 'no longer a member',
  };
}

// ── Update ───────────────────────────────────────────────────────────────────

async function anonymizeOrphans(orphans) {
  let updated = 0;
  for (let i = 0; i < orphans.length; i += UPDATE_BATCH_LIMIT) {
    const chunk = orphans.slice(i, i + UPDATE_BATCH_LIMIT);
    const batch = db.batch();
    for (const orphan of chunk) batch.update(orphan.ref, { submittedBy: null, userName: null });
    try {
      await batch.commit();
      updated += chunk.length;
    } catch (err) {
      console.error(`  FAILED after anonymising ${updated}/${orphans.length} tickets`);
      throw err;
    }
  }
  return updated;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const mode = APPLY ? 'APPLY (writes)' : 'DRY RUN (read-only)';

  console.log('');
  console.log(`  Project : ${projectId}`);
  console.log(`  Auth    : ${credentialSource}`);
  console.log(`  Mode    : ${mode}`);
  console.log(
    `  PII     : ${SHOW_PII ? 'FULL — do not save or paste this output' : 'masked (pass --show-pii for full values)'}`,
  );
  console.log('');

  if (SHOW_PII) {
    console.error(
      'WARNING: --show-pii passed — submitter uids and names will print in clear text below. ' +
        'Do not save this output to a file or CI artifact.',
    );
  }

  let scanned = 0;
  const orphans = [];

  for await (const candidate of candidateTickets()) {
    scanned += 1;
    const orphan = await classifyTicket(candidate);
    if (orphan) orphans.push(orphan);
  }

  console.log(`  ${scanned} ticket${scanned === 1 ? '' : 's'} with a submittedBy scanned`);
  console.log('');

  if (orphans.length === 0) {
    console.log('  No orphaned tickets found.');
  } else {
    console.log(`  Found ${orphans.length} orphaned ticket${orphans.length === 1 ? '' : 's'}:`);
    console.log('');
    console.log(`  ticket id       company id                      company name              submitted by     userName              reason`);
    for (const o of orphans) {
      const submittedBy = SHOW_PII ? o.submittedBy : maskId(o.submittedBy);
      const userName = SHOW_PII ? (o.userName ?? '—') : maskName(o.userName);
      console.log(
        `  ${pad(o.ticketId, 14)}  ${pad(o.companyId ?? '—', 30)}  ${pad(o.companyName ?? '—', 24)}  ` +
          `${pad(submittedBy, 15)}  ${pad(userName, 20)}  ${o.reason}`,
      );
    }
    console.log('');

    if (APPLY) {
      const updated = await anonymizeOrphans(orphans);
      console.log(`  Anonymised ${updated} ticket${updated === 1 ? '' : 's'}.`);
    } else {
      console.log('  Re-run with --yes to anonymise.');
    }
  }

  console.log('');
}

function pad(str, len) {
  const s = String(str);
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  if (PROJECT && /credential|authenticat|permission|PERMISSION_DENIED/i.test(err.message)) {
    console.error('');
    console.error('  Using application default credentials. If they are missing or lack access:');
    console.error('    gcloud auth application-default login');
    console.error(`    gcloud projects get-iam-policy ${projectId}   # check your access`);
  }
  process.exit(1);
});
