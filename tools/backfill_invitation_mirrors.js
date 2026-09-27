/**
 * One-off backfill for the `invitations/{token}` mirror collection — issue
 * #297.
 *
 * The mirror is a top-level, publicly readable (`allow get: if true`) doc
 * that carries the invitee's email address. Going forward:
 *   - accept (`functions/src/auth/acceptInvitation.ts`) deletes it.
 *   - revoke (`actions/team.ts` `revokeInvitation`) deletes it.
 *   - resend (`actions/team.ts` `extendPendingInvite`) recreates it with an
 *     `expireAt` TTL field.
 *   - a Firestore TTL policy (`firestore.indexes.json` `fieldOverrides`,
 *     `collectionGroup: "invitations"`) reclaims any mirror whose
 *     `expireAt` has passed.
 *
 * None of that touches mirrors that already existed before this PR
 * deployed — an already-accepted or already-revoked mirror still sits there
 * with a stale `status`, and a still-pending one has no `expireAt` at all.
 * This script closes that gap, one time, for the pre-existing backlog.
 *
 * ── Per-mirror decision ───────────────────────────────────────────────────
 * See `tools/lib/invitationMirrorBackfill.js`'s own docblock for the full
 * reasoning; in short:
 *   1. `status !== 'pending'` (accepted/revoked/legacy)   -> delete.
 *   2. pending, has `expiresAt`, missing `expireAt`        -> set `expireAt`.
 *   3. pending, no `expiresAt` at all (legacy, never expires) -> skip &
 *      count separately — decide what to do with these later.
 *   4. pending, already has `expireAt`                     -> nothing to do.
 *
 * ── Scope: the top-level mirror collection ONLY ──────────────────────────
 * This pages `db.collection('invitations')` — the top-level collection —
 * NOT `db.collectionGroup('invitations')`. A collection-group query would
 * also match every `companies/{cid}/invitations/*` PRIVATE doc, and this
 * script must never touch those: they don't get `expireAt`, and they
 * certainly don't get deleted just because their `status` isn't 'pending'
 * (that's the normal, permanent state of every accepted/revoked invite
 * record). `db.collection('invitations')` on its own only ever resolves to
 * the top-level collection, so this is a hard scope guarantee, not just a
 * filter.
 *
 * ── Scan-then-apply — writes never interleave with paging ────────────────
 * `scanMirrors` pages through and classifies the ENTIRE collection first,
 * building the full `toDelete`/`toSetExpireAt` lists in memory, and only
 * once that's done does `main` hand them to `applyWrites`. No delete or
 * `expireAt` write is ever issued from inside the paging loop itself —
 * deleting a doc while `orderBy('__name__').startAfter(cursor)` is still
 * walking the same collection is exactly the kind of mutate-during-scan bug
 * that can skip or double-visit documents depending on the backend's
 * pagination guarantees. Same reasoning as
 * `tools/backfill_mail_expire_at.js`'s `findDocsMissingExpireAt` /
 * `applyExpireAt` split.
 *
 * ── Output is COUNTS ONLY — never an email, token or doc id ─────────────
 * Same stance as `tools/backfill_mail_expire_at.js`: the summary this script
 * prints is bucketed counts, nothing else. A mirror doc id IS the invite
 * token — a bearer credential — so it is even more sensitive to print here
 * than a mail doc id ever was; this script never logs one, in dry run or
 * apply mode.
 *
 * ── WARNING: TTL deletes fast once applied ───────────────────────────────
 * Firestore's TTL service typically reclaims an expired document within
 * about 24 hours of it becoming eligible — NOT instantly. Any mirror this
 * script stamps with an `expireAt` that's already in the past (its
 * `expiresAt` already elapsed) will be deleted by Firestore within roughly
 * a day of this script's `--yes` run. Point-in-time recovery (PITR, enabled
 * on every environment) only reaches back 7 days — there is no way to
 * recover a mirror TTL has already reclaimed once that window has passed.
 * The same is true, more directly, for every mirror this script deletes
 * outright (bucket 1 above) — that is an immediate, non-TTL delete. Run
 * `--yes` only after a dry run has been reviewed.
 *
 * ── Usage, from the repo root ─────────────────────────────────────────────
 *   node tools/backfill_invitation_mirrors.js --project=allocate-alpha        # dry run
 *   node tools/backfill_invitation_mirrors.js --project=allocate-alpha --yes  # apply
 *   node tools/backfill_invitation_mirrors.js --project=allocate-beta         # dry run
 *   node tools/backfill_invitation_mirrors.js --project=allocate-beta --yes   # apply
 *   node tools/backfill_invitation_mirrors.js --project=allocate-e0735        # dry run (prod)
 *   node tools/backfill_invitation_mirrors.js --project=allocate-e0735 --yes  # apply (prod)
 *
 * Credentials, in resolution order (identical to
 * tools/backfill_mail_expire_at.js / tools/inventory_invitations.js):
 *   --project=<id>  Application Default Credentials. Preferred — no long-lived
 *                   key file on disk, and it reaches every project your gcloud
 *                   login can. Requires `gcloud auth application-default login`
 *                   once.
 *   --sa=<path>     an explicit service account key file.
 *   neither         FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON from .env.local, which
 *                   only ever points at one project.
 * Passing both --project and --sa is an error.
 *
 * --dry-run is the DEFAULT. Nothing is written unless --yes is passed.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { decideMirrorAction } = require('./lib/invitationMirrorBackfill');

// ── Arguments ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

if (flag('help') || flag('h')) {
  console.log(`
  Backfill invitations/{token} mirrors with the expireAt TTL field, and
  clean up mirrors left over from before delete-on-accept/-revoke shipped
  (issue #297).

  Usage:
    node tools/backfill_invitation_mirrors.js --project=<id> [--yes]
    node tools/backfill_invitation_mirrors.js --sa=<path> [--yes]
    node tools/backfill_invitation_mirrors.js [--yes]   # falls back to .env.local

  --yes   apply the writes. Without it, this is a dry run (default).
  --help  print this message and exit.
`);
  process.exit(0);
}

const APPLY = flag('yes');
const SA_PATH = value('sa');
const PROJECT = value('project');
const WRITE_BATCH_LIMIT = 490;
const PAGE_SIZE = 500;

// ── Credentials (identical resolution to tools/backfill_mail_expire_at.js) ──

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

if (PROJECT && SA_PATH) {
  console.error('ERROR: pass either --project or --sa, not both.');
  process.exit(1);
}

const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

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

// ── Scan ─────────────────────────────────────────────────────────────────────

/**
 * Pages through the ENTIRE top-level `invitations` collection (ordered by
 * `__name__`, `PAGE_SIZE` at a time — same pagination pattern as
 * `tools/backfill_mail_expire_at.js`) and classifies every doc via
 * `decideMirrorAction`. Returns `{ toDelete, toSetExpireAt, skippedNoExpiry,
 * alreadyOk }` — refs plus whatever each action needs, nothing else. Never
 * collects an email, token or doc id into anything that gets logged.
 */
async function scanMirrors() {
  const toDelete = [];
  const toSetExpireAt = [];
  let skippedNoExpiry = 0;
  let alreadyOk = 0;
  let scanned = 0;

  let cursor = null;
  for (;;) {
    let q = db.collection('invitations').orderBy('__name__').limit(PAGE_SIZE);
    // Pass the snapshot itself, not the id — with __name__ ordering
    // Firestore expects a reference (same gotcha as
    // tools/backfill_mail_expire_at.js / tools/cleanup_orphan_members.js).
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;

    scanned += snap.docs.length;
    for (const doc of snap.docs) {
      const decision = decideMirrorAction(doc.data());
      switch (decision.action) {
        case 'delete':
          toDelete.push(doc.ref);
          break;
        case 'set_expire_at':
          toSetExpireAt.push({ ref: doc.ref, expireAtMillis: decision.expireAtMillis });
          break;
        case 'skip_no_expiry':
          skippedNoExpiry += 1;
          break;
        case 'ok':
          alreadyOk += 1;
          break;
      }
    }

    if (snap.size < PAGE_SIZE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }

  console.log(`  scanned ${scanned} 'invitations' mirror docs`);
  return { toDelete, toSetExpireAt, skippedNoExpiry, alreadyOk };
}

/**
 * Applies both the deletes and the expireAt writes in one set of chunked
 * batches (WRITE_BATCH_LIMIT each) — same shape as
 * `tools/backfill_mail_expire_at.js`'s `applyExpireAt`. If a commit throws
 * partway through, the chunks already committed are reported before the
 * error propagates.
 */
async function applyWrites(toDelete, toSetExpireAt) {
  const ops = [
    ...toDelete.map((ref) => ({ kind: 'delete', ref })),
    ...toSetExpireAt.map(({ ref, expireAtMillis }) => ({ kind: 'set_expire_at', ref, expireAtMillis })),
  ];

  const totalChunks = Math.ceil(ops.length / WRITE_BATCH_LIMIT) || 0;
  let committed = 0;

  for (let i = 0, chunkIndex = 0; i < ops.length; i += WRITE_BATCH_LIMIT, chunkIndex += 1) {
    const chunk = ops.slice(i, i + WRITE_BATCH_LIMIT);
    const batch = db.batch();
    for (const op of chunk) {
      if (op.kind === 'delete') {
        batch.delete(op.ref);
      } else {
        batch.update(op.ref, { expireAt: Timestamp.fromMillis(op.expireAtMillis) });
      }
    }

    try {
      await batch.commit();
      committed += chunk.length;
      console.log(`  chunk ${chunkIndex + 1}/${totalChunks} committed (${chunk.length} ops, ${committed}/${ops.length} total)`);
    } catch (err) {
      // Never log `err`/`err.message` here — a Firestore write error commonly
      // embeds the failing document's PATH in its message, and a mirror doc's
      // id IS the invite token, a bearer credential. `err.code` (a gRPC
      // status enum, e.g. 5 = NOT_FOUND) carries none of that and is enough
      // to diagnose a class of failure.
      console.error(
        `  FAILED committing chunk ${chunkIndex + 1}/${totalChunks} (code=${err && err.code !== undefined ? err.code : 'unknown'}) — ${committed}/${ops.length} ops already committed before the failure`,
      );
      throw err;
    }
  }

  return committed;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const mode = APPLY ? 'APPLY (writes)' : 'DRY RUN (read-only)';

  console.log('');
  console.log(`  Project : ${projectId}`);
  console.log(`  Auth    : ${credentialSource}`);
  console.log(`  Mode    : ${mode}`);
  console.log('');

  const { toDelete, toSetExpireAt, skippedNoExpiry, alreadyOk } = await scanMirrors();

  const now = Date.now();
  let alreadyExpired = 0;
  for (const { expireAtMillis } of toSetExpireAt) {
    if (expireAtMillis <= now) alreadyExpired += 1;
  }

  console.log('  ── Counts ────────────────────────────────────────────────────────────');
  console.log(`  Non-pending (accepted/revoked/legacy) -> will be deleted : ${toDelete.length}`);
  console.log(`  Pending, missing expireAt -> will be stamped             : ${toSetExpireAt.length}`);
  console.log(`    of which already expired (TTL reclaims within ~24h)    : ${alreadyExpired}`);
  console.log(`  Pending, no expiresAt at all (legacy) -> skipped         : ${skippedNoExpiry}`);
  console.log(`  Pending, already has expireAt -> nothing to do           : ${alreadyOk}`);
  console.log('');

  if (skippedNoExpiry > 0) {
    console.log(`  NOTE: ${skippedNoExpiry} pending mirror(s) have no expiresAt at all (written`);
    console.log('  before invite expiry existed) and were left untouched. Decide separately');
    console.log('  what to do with these — this script does not guess an expiry for them.');
    console.log('');
  }

  if (!APPLY) {
    console.log('  Dry run only — no writes made. Re-run with --yes to apply.');
    console.log('');
    console.log('  WARNING: on --yes, every "will be deleted" mirror above is deleted');
    console.log('  immediately (not via TTL), and any "already expired" mirror among the');
    console.log('  ones stamped with expireAt will be reclaimed by Firestore TTL within');
    console.log('  roughly 24 hours — PITR only covers the last 7 days. See this script\'s');
    console.log('  own header docblock.');
    console.log('');
    return;
  }

  if (toDelete.length === 0 && toSetExpireAt.length === 0) {
    console.log('  Nothing to write.');
    console.log('');
    return;
  }

  console.log('  ── Applying writes ──────────────────────────────────────────────────');
  const committed = await applyWrites(toDelete, toSetExpireAt);
  console.log(`  Done. ${committed}/${toDelete.length + toSetExpireAt.length} ops committed.`);
  console.log('');
}

main().catch((err) => {
  // Same PII stance as the per-chunk catch in applyWrites above: never log
  // `err`/`err.message` — it can carry a Firestore document path, and a
  // mirror doc's id is the invite token itself. `err.code` only.
  console.error(`Unhandled error (code=${err && err.code !== undefined ? err.code : 'unknown'})`);
  process.exit(1);
});
