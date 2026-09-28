/**
 * READ-ONLY inventory of `operatorFeedback` ticket-id collision evidence
 * (issue #424).
 *
 * ── The bug ──────────────────────────────────────────────────────────────
 * Before #424, `submitFeedback` (actions/submitFeedback.ts) generated ticket
 * ids as `${prefix}-${random 1000-9999}` and wrote them with a plain `.set()`
 * on `operatorFeedback/{id}`. A collision (~1-in-9000 per submit, three
 * independent ranges since each prefix rolled its own random number) meant
 * one user's ticket silently overwrote another's — including clearing
 * `closedAt` (which could hide the ticket from `purgeOldFeedback`'s
 * retention sweep forever) and detaching the `notes` subcollection
 * (app/operator/(protected)/feedback/actions.ts), which stayed attached to
 * the doc id but now belongs, in spirit, to whichever submission last won
 * the id. #424 replaced this with a single sequential counter starting at
 * 10000, so no *new* collision can occur — this script looks for evidence
 * that an *old* one already happened, to scope whether any cleanup is
 * needed.
 *
 * ── The heuristic, and its limits ───────────────────────────────────────
 * A collision leaves one reliable trace: a note in `notes` whose
 * `createdAt` is EARLIER than the ticket's own `submittedAt`. That can only
 * happen if the note was written against an earlier ticket that used to
 * live at this same doc id, before a later submit's `.set()` overwrote the
 * ticket fields (submittedAt included) out from under it. This script flags
 * every ticket where that's true for at least one note.
 *
 * This heuristic has real gaps and both are one-directional (it can only
 * under-count, never over-count, an actual collision):
 *   - An overwrite of a ticket that has NO notes yet (the common case —
 *     most tickets are closed by an operator before ever collecting notes)
 *     leaves no trace at all. The new ticket's `submittedAt` is just later
 *     than the old one's would have been, and nothing else survives to
 *     compare it against.
 *   - If a collision happened and the *original* ticket's notes were later
 *     deleted (there's no delete path today, but this is future-proofing,
 *     not a claim it's happened), the same is true.
 * In other words: a ticket flagged by this script is strong evidence of a
 * real collision. A ticket NOT flagged is not evidence that no collision
 * happened to it.
 *
 * ── What this script does and does not do ───────────────────────────────
 * READ-ONLY. Every Firestore call in this file is `.get()`. There is no
 * write path, no flag that enables one, and this script never repairs,
 * backfills, or deletes anything.
 *
 * Output is limited to ticket ids (which are just `${PREFIX}-${number}`,
 * not PII), prefixes, counts, and timestamps. It NEVER prints a ticket's
 * title, description, userName, companyName, submittedBy uid, a note's
 * text, or a note's createdBy — none of that is needed to scope the
 * problem, and some of it (title/description free text) can contain PII a
 * user typed into the feedback form themselves.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *   node tools/inventory_feedback_collisions.js --project=allocate-alpha
 *   node tools/inventory_feedback_collisions.js --project=allocate-e0735
 *   node tools/inventory_feedback_collisions.js --sa=/path/to/service-account.json
 *   node tools/inventory_feedback_collisions.js   # falls back to .env.local
 *   node tools/inventory_feedback_collisions.js --project=allocate-alpha --json
 *
 * Credentials, in resolution order (same as tools/inventory_invitations.js):
 *   --project=<id>  Application Default Credentials.
 *   --sa=<path>     an explicit service account key file.
 *   neither         FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON from .env.local.
 * Passing both --project and --sa is an error.
 *
 * Output: a summary to stdout. With --json, the same data is printed as a
 * single JSON object instead of the plain-text report (still ids/counts/
 * timestamps only, no PII, and still nothing is written to disk).
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Arguments ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const flag = (name) => args.includes(`--${name}`);

const SA_PATH = value('sa');
const PROJECT = value('project');
const JSON_OUTPUT = flag('json');

const KNOWN_PREFIXES = ['BUG', 'FEA', 'SUP'];

// ── Credentials (identical resolution to tools/inventory_invitations.js) ───

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

// Firestore Timestamp -> ISO string, or null if missing/not a Timestamp.
const toIso = (v) => (v && typeof v.toDate === 'function' ? v.toDate().toISOString() : null);

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const ticketsSnap = await db.collection('operatorFeedback').get();

  const tickets = ticketsSnap.docs.map((doc) => {
    const data = doc.data();
    const dash = doc.id.indexOf('-');
    const prefix = dash === -1 ? '(unrecognised)' : doc.id.slice(0, dash);
    return {
      id: doc.id,
      prefix: KNOWN_PREFIXES.includes(prefix) ? prefix : '(unrecognised)',
      submittedAt: data.submittedAt ?? null,
      // null or a non-Timestamp counts as missing — `.toDate()` below needs a real one.
      hasSubmittedAt: toIso(data.submittedAt) !== null,
    };
  });

  const totalTickets = tickets.length;

  const byPrefix = {};
  for (const t of tickets) byPrefix[t.prefix] = (byPrefix[t.prefix] ?? 0) + 1;

  const missingSubmittedAt = tickets.filter((t) => !t.hasSubmittedAt);

  // ── Read `notes` subcollections in parallel and check for the collision
  // heuristic: any note whose createdAt predates the ticket's submittedAt.
  const withNotes = [];
  const flagged = [];

  await Promise.all(
    tickets.map(async (t) => {
      const notesSnap = await db.collection(`operatorFeedback/${t.id}/notes`).get();
      if (notesSnap.empty) return;

      withNotes.push(t.id);

      // No submittedAt at all -> nothing to compare against; can't apply
      // the heuristic, but this is itself worth surfacing separately (see
      // missingSubmittedAt above) rather than silently skipped here.
      if (!t.hasSubmittedAt) return;

      const ticketMs = t.submittedAt.toDate().getTime();
      const earlierNotes = [];
      for (const noteDoc of notesSnap.docs) {
        const noteData = noteDoc.data();
        const createdAt = noteData.createdAt;
        if (createdAt && typeof createdAt.toDate === 'function' && createdAt.toDate().getTime() < ticketMs) {
          earlierNotes.push({ noteId: noteDoc.id, createdAt: toIso(createdAt) });
        }
      }
      if (earlierNotes.length > 0) {
        flagged.push({
          ticketId: t.id,
          submittedAt: toIso(t.submittedAt),
          earlierNoteCount: earlierNotes.length,
          earlierNotes,
        });
      }
    }),
  );

  const result = {
    project: projectId,
    credentialSource,
    totals: {
      tickets: totalTickets,
      byPrefix,
      withNotes: withNotes.length,
      missingSubmittedAt: missingSubmittedAt.length,
    },
    missingSubmittedAtIds: missingSubmittedAt.map((t) => t.id),
    likelyCollisions: {
      count: flagged.length,
      tickets: flagged,
    },
  };

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('');
  console.log(`  Project : ${projectId}`);
  console.log(`  Auth    : ${credentialSource}`);
  console.log('  Mode    : READ-ONLY inventory (no writes exist in this script)');
  console.log('');
  console.log(`  Total operatorFeedback tickets : ${totalTickets}`);
  console.log('  By prefix:', JSON.stringify(byPrefix));
  console.log(`  Tickets with at least one note : ${withNotes.length}`);
  console.log(`  Tickets missing submittedAt    : ${missingSubmittedAt.length}`);
  for (const id of missingSubmittedAt.map((t) => t.id)) console.log(`    ${id}`);
  console.log('');

  console.log('  ── Issue #424: likely id collisions (note predates ticket) ────────');
  console.log(`  Flagged tickets : ${flagged.length}`);
  for (const f of flagged) {
    console.log(`    ${f.ticketId}  submittedAt=${f.submittedAt}  earlierNotes=${f.earlierNoteCount}`);
    for (const n of f.earlierNotes) console.log(`      note ${n.noteId}  createdAt=${n.createdAt}`);
  }
  if (flagged.length > 0) {
    console.log('');
    console.log('  NOTE: this heuristic only catches overwrites of tickets that already');
    console.log('  had notes at the time of the collision. A ticket not listed above may');
    console.log('  still have been overwritten — see the docblock for why.');
  }
  console.log('');
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
