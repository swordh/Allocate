/**
 * One-off backfill: set `closedAt` on existing `operatorFeedback` tickets
 * that are already closed (`status` is `done` or `wont_fix`) but predate
 * the field.
 *
 * Background: issue #338 PR 2 adds `closedAt` to `operatorFeedback` docs,
 * written going forward by `updateFeedbackStatus`
 * (app/operator/(protected)/feedback/actions.ts) on every open-ish → closed
 * transition. `functions/src/admin/purgeOldFeedback.ts` deletes a ticket 24
 * months after `closedAt` — a ticket that was closed before this shipped has
 * no `closedAt` at all, and would never age out under that job no matter
 * how old it gets, since a missing field never matches a `<` range filter.
 * This script gives those tickets a `closedAt` so the purge job can see
 * them too.
 *
 * Source of the backfilled value, per ticket, in priority order:
 *   1. `createdAt` of the most recent CLOSING transition in
 *      `operatorFeedback/{id}/notes` — a `kind: 'event'` doc whose FROM
 *      status is NOT closed and whose TO status IS (see
 *      `tools/lib/feedbackClosedAtClassification.js`'s
 *      `isClosingTransition`). This is deliberately narrower than "any event
 *      ending in → DONE / → NO ACTION": a closed → closed RECLASSIFICATION
 *      (`done` ↔ `wont_fix`, e.g. "NO ACTION → DONE") also ends that way but
 *      is NOT a new closing — `updateFeedbackStatus` itself leaves
 *      `closedAt` untouched for that transition (see its own "closed →
 *      closed: keep existing closedAt" branch) — so counting it here would
 *      over-estimate how long the ticket has been closed and purge it later
 *      than the 24-month policy intends. "Most recent" matters on its own
 *      too: a ticket can be closed, reopened, and closed again — only the
 *      LAST closing transition reflects when it most recently became
 *      closed, and a later closed → closed reclassification of that same
 *      closure must not push the timestamp forward either.
 *   2. `submittedAt` on the ticket itself, if no such transition exists — either
 *      the ticket was created already-closed (no status-change event ever
 *      fired) or it predates the notes subcollection entirely. This likely
 *      OVER-estimates how long the ticket has been closed, which is the
 *      conservative direction to be wrong in for a retention job: it purges
 *      slightly earlier, never keeps something past its legal basis for
 *      longer than intended in the other direction (a ticket wrongly kept
 *      forever because it doesn't match this script's expectations at all).
 *
 * Usage, from the repo root:
 *   node tools/backfill_feedback_closed_at.js --project=allocate-alpha             # dry run
 *   node tools/backfill_feedback_closed_at.js --project=allocate-alpha --yes       # apply
 *   node tools/backfill_feedback_closed_at.js --project=allocate-beta             # dry run
 *   node tools/backfill_feedback_closed_at.js --project=allocate-beta --yes       # apply
 *   node tools/backfill_feedback_closed_at.js --project=allocate-e0735            # dry run (prod)
 *   node tools/backfill_feedback_closed_at.js --project=allocate-e0735 --yes      # apply (prod)
 *
 * --dry-run is the DEFAULT. Nothing is written unless --yes is passed.
 * The script is idempotent: a ticket that already has `closedAt` is never
 * re-examined or re-written (see the `where('closedAt', '==', null)`-style
 * filter note below — Firestore has no "field absent" query operator, so
 * this fetches every done/wont_fix ticket and filters `closedAt` presence
 * in memory instead; see FILTERING NOTE below).
 *
 * The report below prints only ticket ids and which source
 * (event/submittedAt) supplied the value — never `userName`, `userEmail`,
 * `description`, or any other field on the ticket. Ticket ids are Firestore
 * auto-ids, not personal data.
 *
 * Rollout order (per environment, same order this whole PR ships in):
 *   1. Deploy the app (2a — `updateFeedbackStatus` starts writing
 *      `closedAt` on every FUTURE close/reopen).
 *   2. Run this backfill (2c — catches up every ticket already closed
 *      before step 1 shipped).
 *   3. Deploy functions (2b — `purgeOldFeedback` starts reading `closedAt`
 *      on its weekly sweep).
 * Running the purge function before the backfill has completed would just
 * mean recently-added `closedAt` values purge on schedule and the
 * not-yet-backfilled ones don't — no incorrect deletion either way, but the
 * order above is what makes the 24-month clock start from the right moment
 * for every already-closed ticket, not just future ones.
 *
 * Credentials, in resolution order (same as tools/cleanup_orphan_members.js):
 *   --project=<id>  Application Default Credentials. Preferred — no
 *                   long-lived key file on disk, and it reaches every
 *                   project your gcloud login can. Requires
 *                   `gcloud auth application-default login` once.
 *   --sa=<path>     an explicit service account key file.
 *   neither         FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON from .env.local,
 *                   which only ever points at one project.
 */

'use strict';

const fs = require('fs');
const path = require('path');

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
const WRITE_BATCH_LIMIT = 490;

// Pure classification logic (no Firestore/admin-app imports) lives in its
// own module so it can be unit-tested directly — see that file's own
// docblock for why the status labels it uses are hardcoded rather than
// imported from types/operator.ts.
const { latestClosingEventCreatedAt } = require('./lib/feedbackClosedAtClassification');

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

// ── Source lookup ────────────────────────────────────────────────────────────

/**
 * The most recent CLOSING transition for one ticket, or null if there isn't
 * one — see `tools/lib/feedbackClosedAtClassification.js`'s
 * `latestClosingEventCreatedAt` for the actual logic. `notes` is small per
 * ticket (an operator's own timeline of notes/status changes on ONE support
 * ticket — realistically single digits to a few dozen), so reading the
 * whole subcollection and classifying in memory is fine; there is no need
 * for a composite index on `kind`+`createdAt` just for this one-off script.
 */
async function findLatestClosingEvent(ticketId) {
  const notesSnap = await db.collection(`operatorFeedback/${ticketId}/notes`).get();
  return latestClosingEventCreatedAt(notesSnap.docs.map((doc) => doc.data()));
}

/**
 * Classifies every closed-but-unbackfilled ticket into its `closedAt`
 * source. FILTERING NOTE: Firestore cannot query "field does not exist",
 * so this fetches every `status in [done, wont_fix]` ticket and filters
 * `closedAt` presence in memory — fine at this collection's realistic
 * scale (operator support tickets, not a high-volume user-facing
 * collection).
 */
async function classifyTickets() {
  const snap = await db.collection('operatorFeedback').where('status', 'in', ['done', 'wont_fix']).get();

  const fromEvent = [];
  const fromSubmittedAt = [];
  const skippedNoSubmittedAt = [];

  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.closedAt) continue; // already backfilled, or set by updateFeedbackStatus post-ship

    const event = await findLatestClosingEvent(doc.id);
    if (event) {
      fromEvent.push({ id: doc.id, ref: doc.ref, closedAt: event });
      continue;
    }

    if (data.submittedAt && typeof data.submittedAt.toMillis === 'function') {
      fromSubmittedAt.push({ id: doc.id, ref: doc.ref, closedAt: data.submittedAt });
    } else {
      // No event, no usable submittedAt — nothing to backfill from. Reported
      // separately so it isn't silently uncounted; a human can look at the
      // one ticket by id.
      skippedNoSubmittedAt.push(doc.id);
    }
  }

  return { fromEvent, fromSubmittedAt, skippedNoSubmittedAt };
}

// ── Write ────────────────────────────────────────────────────────────────────

async function applyBackfill(entries) {
  let written = 0;
  for (let i = 0; i < entries.length; i += WRITE_BATCH_LIMIT) {
    const chunk = entries.slice(i, i + WRITE_BATCH_LIMIT);
    const batch = db.batch();
    for (const entry of chunk) batch.update(entry.ref, { closedAt: entry.closedAt });
    await batch.commit();
    written += chunk.length;
  }
  return written;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const mode = APPLY ? 'APPLY (writes)' : 'DRY RUN (read-only)';

  console.log('');
  console.log(`  Project : ${projectId}`);
  console.log(`  Auth    : ${credentialSource}`);
  console.log(`  Mode    : ${mode}`);
  console.log('');

  const { fromEvent, fromSubmittedAt, skippedNoSubmittedAt } = await classifyTickets();

  console.log(`  ${fromEvent.length} ticket(s) — closedAt from most recent closing event:`);
  for (const entry of fromEvent) console.log(`    ${entry.id}  source=event`);
  console.log('');

  console.log(`  ${fromSubmittedAt.length} ticket(s) — closedAt from submittedAt (fallback, no closing event found):`);
  for (const entry of fromSubmittedAt) console.log(`    ${entry.id}  source=submittedAt`);
  console.log('');

  if (skippedNoSubmittedAt.length > 0) {
    console.log(`  ${skippedNoSubmittedAt.length} ticket(s) SKIPPED — no closing event and no usable submittedAt:`);
    for (const id of skippedNoSubmittedAt) console.log(`    ${id}`);
    console.log('');
  }

  const toWrite = [...fromEvent, ...fromSubmittedAt];
  console.log(`  Total to backfill: ${toWrite.length}`);
  console.log('');

  if (!APPLY) {
    console.log('  DRY RUN — no writes made. Pass --yes to apply.');
    return;
  }

  if (toWrite.length === 0) {
    console.log('  Nothing to write.');
    return;
  }

  const written = await applyBackfill(toWrite);
  console.log(`  Wrote closedAt on ${written} ticket(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
