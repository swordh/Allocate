/**
 * One-off backfill: stamps `expireAt` (the Firestore TTL field, issue #325)
 * onto every EXISTING `mail/{id}` document that doesn't already have one.
 *
 * Every writer of a `mail` doc now sets `expireAt` at write time (see
 * `lib/mail-retention.ts` / `functions/src/email/mailRetention.ts`), but that
 * only covers documents created AFTER this PR deploys. Every mail doc queued
 * before then has no `expireAt` at all and would otherwise sit in Firestore
 * forever — exactly the unbounded-retention problem issue #325 exists to
 * close. This script closes the gap for the pre-existing backlog.
 *
 * ── Per-document `expireAt` ──────────────────────────────────────────────
 * See `tools/lib/mailExpireAtCompute.js`'s own docblock for the full
 * reasoning; in short:
 *   1. `status === 'sent'` with a `sentAt` Timestamp -> `sentAt` + 30 days.
 *   2. Otherwise, a `failedAt` Timestamp -> `failedAt` + 90 days.
 *   3. Otherwise, the document's own Firestore `createTime` + 90 days.
 * Never `createdAt` — six of the twelve writers never set it, and where it
 * exists it's an ISO string, not a Timestamp; `createTime` is a property
 * every Firestore document already has and answers the same question.
 *
 * ── Only touches docs missing `expireAt` ─────────────────────────────────
 * Idempotent by construction: a doc already carrying `expireAt` (freshly
 * queued by this PR's own writers, or already backfilled by an earlier run
 * of this exact script) is filtered out client-side and never rewritten.
 *
 * ── Why no `where('expireAt', '==', null)` ───────────────────────────────
 * Firestore has no "field does not exist" query operator, so — same
 * reasoning as `tools/migrate_viewer_to_crew.js`'s "Why no where(...)"
 * section — this script pages through the WHOLE `mail` collection ordered by
 * `__name__` and filters `expireAt === undefined` client-side, rather than
 * requiring an index for a query Firestore can't actually express anyway.
 *
 * ── Output is COUNTS ONLY — never an address, name or doc id ─────────────
 * The summary this script prints breaks the backlog down by status and by
 * how soon the computed `expireAt` would fall (already expired / <30 days /
 * 30-90 days) — nothing else. No recipient address, no template data, no
 * document id, in either dry-run or apply mode. This mirrors
 * `tools/cleanup_orphan_members.js`'s PII stance (see `tools/lib/mask_pii.js`)
 * taken one step further: this script needs no masked identifiers at all,
 * because nothing it prints ever needs to be traced back to a specific mail.
 *
 * ── WARNING: TTL deletes fast once applied ───────────────────────────────
 * Firestore's TTL service typically reclaims an expired document within
 * about 24 hours of it becoming eligible — NOT instantly. Any document this
 * script marks as "already expired" (its computed `expireAt` is already in
 * the past) will be deleted by Firestore within roughly a day of this
 * script's `--yes` run, not at some future date. Point-in-time recovery
 * (PITR, enabled on every environment as of the "PITR och Firestore-region"
 * decision) only reaches back 7 days — there is NO way to recover a mail doc
 * TTL has already reclaimed once that window has passed. Run `--yes` only
 * after a dry run has been reviewed.
 *
 * ── Usage, from the repo root ─────────────────────────────────────────────
 *   node tools/backfill_mail_expire_at.js --project=allocate-alpha           # dry run
 *   node tools/backfill_mail_expire_at.js --project=allocate-alpha --yes     # apply
 *   node tools/backfill_mail_expire_at.js --project=allocate-beta            # dry run
 *   node tools/backfill_mail_expire_at.js --project=allocate-beta --yes      # apply
 *   node tools/backfill_mail_expire_at.js --project=allocate-e0735           # dry run (prod)
 *   node tools/backfill_mail_expire_at.js --project=allocate-e0735 --yes     # apply (prod)
 *
 * Credentials, in resolution order (identical to
 * tools/migrate_viewer_to_crew.js / tools/cleanup_orphan_members.js):
 *   --project=<id>  Application Default Credentials. Preferred — no long-lived
 *                   key file on disk, and it reaches every project your gcloud
 *                   login can. Requires `gcloud auth application-default login`
 *                   once.
 *   --sa=<path>     an explicit service account key file.
 *   neither         FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON from .env.local, which
 *                   only ever points at one project.
 *
 * --dry-run is the DEFAULT. Nothing is written unless --yes is passed.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { computeExpireAtMillis, classifyBucket } = require('./lib/mailExpireAtCompute');

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
const PAGE_SIZE = 500;

// ── Credentials (identical resolution to tools/migrate_viewer_to_crew.js) ────

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
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

// One source only. Silently preferring one over the other is how you end up
// writing to the wrong project.
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

// ── Scan ─────────────────────────────────────────────────────────────────────

/**
 * A Firestore `Timestamp` field value, or `undefined` if the doc doesn't
 * have that field (or it isn't actually a Timestamp — a corrupt/legacy doc
 * shouldn't crash the whole run over one bad field).
 */
function timestampMillis(data, field) {
  const v = data[field];
  if (v && typeof v.toMillis === 'function') return v.toMillis();
  return undefined;
}

/**
 * Pages through the ENTIRE `mail` collection (ordered by `__name__`,
 * `PAGE_SIZE` at a time — see the module docblock's "Why no where(...)"
 * section) and returns `{ ref, expireAtMillis, status }` for every doc
 * that's missing `expireAt`. Never returns an address, template data, or
 * anything else identifying — only what's needed to write the field and
 * bucket it for the summary.
 */
async function findDocsMissingExpireAt() {
  const matches = [];
  let cursor = null;
  let scanned = 0;

  for (;;) {
    let q = db.collection('mail').orderBy('__name__').limit(PAGE_SIZE);
    // Pass the snapshot itself, not the id — with __name__ ordering Firestore
    // expects a reference, and a bare id string silently paginates wrong
    // (same gotcha as tools/cleanup_orphan_members.js and
    // tools/migrate_viewer_to_crew.js).
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;

    scanned += snap.docs.length;
    for (const doc of snap.docs) {
      const data = doc.data();
      if (data.expireAt !== undefined) continue;

      const expireAtMillis = computeExpireAtMillis({
        status: data.status,
        sentAtMillis: timestampMillis(data, 'sentAt'),
        failedAtMillis: timestampMillis(data, 'failedAt'),
        createTimeMillis: doc.createTime.toMillis(),
      });

      matches.push({
        ref: doc.ref,
        expireAtMillis,
        status: typeof data.status === 'string' ? data.status : 'unknown',
      });
    }

    if (snap.size < PAGE_SIZE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }

  console.log(`  scanned ${scanned} 'mail' docs, ${matches.length} missing 'expireAt'`);
  return matches;
}

/**
 * Writes `expireAt` on every doc in `docs`, chunked at WRITE_BATCH_LIMIT.
 * Same shape as tools/migrate_viewer_to_crew.js's `migrateRoleField` — if a
 * commit throws partway through, the chunks already committed are reported
 * before the error propagates.
 */
async function applyExpireAt(docs) {
  const totalChunks = Math.ceil(docs.length / WRITE_BATCH_LIMIT) || 0;
  let committed = 0;

  for (let i = 0, chunkIndex = 0; i < docs.length; i += WRITE_BATCH_LIMIT, chunkIndex += 1) {
    const chunk = docs.slice(i, i + WRITE_BATCH_LIMIT);
    const batch = db.batch();
    for (const { ref, expireAtMillis } of chunk) {
      batch.update(ref, { expireAt: Timestamp.fromMillis(expireAtMillis) });
    }

    try {
      await batch.commit();
      committed += chunk.length;
      console.log(`  chunk ${chunkIndex + 1}/${totalChunks} committed (${chunk.length} docs, ${committed}/${docs.length} total)`);
    } catch (err) {
      console.error(
        `  FAILED committing chunk ${chunkIndex + 1}/${totalChunks} — ${committed}/${docs.length} docs already committed before the failure`,
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

  const docs = await findDocsMissingExpireAt();

  const now = Date.now();
  const byStatus = new Map();
  const byBucket = new Map();
  for (const { status, expireAtMillis } of docs) {
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    const bucket = classifyBucket(expireAtMillis, now);
    byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + 1);
  }

  console.log('  ── Counts by status ─────────────────────────────────────────────────');
  if (byStatus.size === 0) console.log('  (none)');
  for (const [status, count] of byStatus) console.log(`  ${status.padEnd(10)} : ${count}`);
  console.log('');

  console.log('  ── Counts by computed expireAt bucket ───────────────────────────────');
  console.log(`  already expired (TTL will reclaim within ~24h of apply) : ${byBucket.get('already_expired') ?? 0}`);
  console.log(`  <30 days out                                            : ${byBucket.get('under_30d') ?? 0}`);
  console.log(`  30-90 days out                                          : ${byBucket.get('30_to_90d') ?? 0}`);
  console.log('');

  if (!APPLY) {
    console.log('  Dry run only — no writes made. Re-run with --yes to apply.');
    console.log('');
    console.log('  WARNING: on --yes, any doc counted as "already expired" above will be');
    console.log('  deleted by Firestore TTL within roughly 24 hours — PITR only covers the');
    console.log('  last 7 days. See this script\'s own header docblock.');
    console.log('');
    return;
  }

  if (docs.length === 0) {
    console.log('  Nothing to write.');
    console.log('');
    return;
  }

  console.log('  ── Applying writes ──────────────────────────────────────────────────');
  const committed = await applyExpireAt(docs);
  console.log(`  Done. ${committed}/${docs.length} docs updated.`);
  console.log('');
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
