/**
 * One-off migration: rewrites every remaining `role: 'viewer'` to `role:
 * 'crew'` (issue #397 — the `viewer` role is removed; `crew` is the lowest
 * role and the fallback everywhere `toRole` (functions/src/auth/role.ts,
 * lib/roles.ts) already coerces a legacy `'viewer'` value on READ).
 *
 * This script closes the gap `toRole` leaves open: `toRole` normalises a
 * stale `viewer` value the moment it's READ (a session claim, a member doc,
 * an invitation), but it never writes anything back — so without this
 * script, `role: 'viewer'` would sit in Firestore and in Auth Custom Claims
 * forever, forever needing the transitional mapping to paper over it. This
 * is the script that actually retires it.
 *
 * ── What it touches ──────────────────────────────────────────────────────
 *
 *   Firestore, by paging through three collection groups and filtering
 *   `role === 'viewer'` client-side (see "Why no where(...)" below):
 *     - `members`      companies/{cid}/members/{uid}          → 'crew'
 *     - `memberships`  users/{uid}/memberships/{cid}          → 'crew'
 *     - `invitations`  companies/{cid}/invitations/{id}       → 'crew'
 *       (the public `invitations/{token}` mirror docs never carry a role
 *       field at all — nothing to migrate there.)
 *
 *   Auth Custom Claims: for every uid touched by the `members` or
 *   `memberships` pass above (an `invitations` doc has no uid — the
 *   invitee may not even have an account yet), if that uid's CURRENT custom
 *   claim `role` is exactly `'viewer'`, the existing claims are spread and
 *   re-set with `role: 'crew'` (same pattern as tools/set-provider-claim.js).
 *   Deliberately does NOT call `revokeRefreshTokens` — `lib/dal.ts`'s
 *   `verifyAuthenticatedSession` already normalises a stale `viewer` claim
 *   to `crew` on every read (issue #398), so an existing session keeps
 *   working correctly in the gap before her token naturally refreshes or
 *   she next signs in with a fresh one.
 *
 * ── Why no `where('role', '==', 'viewer')` ───────────────────────────────
 * A single-equality collectionGroup query needs a single-field index at
 * COLLECTION_GROUP scope, which Firestore does not build automatically the
 * way it does for plain single-collection queries — the first run against a
 * project without one would throw `FAILED_PRECONDITION`. Adding that index
 * just for a one-off migration script isn't worth it, so this script instead
 * pages through every doc in each collection group with a plain
 * `collectionGroup(name).get()` (ordered by `__name__`, PAGE_SIZE at a time)
 * and filters `role === 'viewer'` client-side. Slower and reads more
 * documents than a filtered query would, but it needs no index at all and
 * every environment behaves identically on the first run.
 *
 * ── Usage, from the repo root ────────────────────────────────────────────
 *   node tools/migrate_viewer_to_crew.js --project=allocate-alpha             # dry run
 *   node tools/migrate_viewer_to_crew.js --project=allocate-alpha --yes       # apply
 *   node tools/migrate_viewer_to_crew.js --project=allocate-beta             # dry run
 *   node tools/migrate_viewer_to_crew.js --project=allocate-beta --yes       # apply
 *   node tools/migrate_viewer_to_crew.js --project=allocate-e0735            # dry run (prod)
 *   node tools/migrate_viewer_to_crew.js --project=allocate-e0735 --yes      # apply (prod)
 *
 * Credentials, in resolution order (identical to tools/cleanup_orphan_members.js):
 *   --project=<id>  Application Default Credentials. Preferred — no long-lived
 *                   key file on disk, and it reaches every project your gcloud
 *                   login can. Requires `gcloud auth application-default login`
 *                   once.
 *   --sa=<path>     an explicit service account key file.
 *   neither         FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON from .env.local, which
 *                   only ever points at one project.
 *
 * --dry-run is the DEFAULT. Nothing is written unless --yes is passed.
 * The script is idempotent: a document already migrated to 'crew' simply
 * won't be picked up by the `role === 'viewer'` filter on the next run.
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
const PAGE_SIZE = 500;

// ── Credentials (identical resolution to tools/cleanup_orphan_members.js) ────

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
const { getAuth } = require('firebase-admin/auth');

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
const auth = getAuth();

// ── Firestore pass ───────────────────────────────────────────────────────────

/**
 * Pages through EVERY doc in `collectionGroupName` (ordered by `__name__`,
 * `PAGE_SIZE` at a time — no filter on the query itself, see the module
 * docblock for why) and returns the ones with `role === 'viewer'`.
 * `uidFromDoc` extracts the affected uid from a matched doc, or `null` when
 * the collection has no uid to extract (invitations).
 */
async function findLegacyViewerDocs(collectionGroupName, uidFromDoc) {
  const matches = [];
  let cursor = null;
  let scanned = 0;

  for (;;) {
    let q = db.collectionGroup(collectionGroupName).orderBy('__name__').limit(PAGE_SIZE);
    // Pass the snapshot itself, not the id — with __name__ ordering
    // Firestore expects a reference, and a bare id string silently
    // paginates wrong (same gotcha as tools/cleanup_orphan_members.js).
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;

    scanned += snap.docs.length;
    for (const doc of snap.docs) {
      if (doc.data().role === 'viewer') {
        matches.push({ ref: doc.ref, path: doc.ref.path, uid: uidFromDoc(doc) });
      }
    }

    if (snap.size < PAGE_SIZE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }

  console.log(`  scanned ${scanned} '${collectionGroupName}' docs, found ${matches.length} with role 'viewer'`);
  return matches;
}

/**
 * Writes `role: 'crew'` on every doc in `docs`, chunked at
 * WRITE_BATCH_LIMIT. Prints progress after each chunk commits. If a commit
 * throws partway through, the chunks committed so far already happened —
 * that has to be reported before the error propagates, or a later "N
 * updated" summary would be a lie about how much of `docs` actually got
 * written. Same shape as tools/cleanup_orphan_members.js's delete loop.
 */
async function migrateRoleField(label, docs) {
  const totalChunks = Math.ceil(docs.length / WRITE_BATCH_LIMIT) || 0;
  let committed = 0;

  for (let i = 0, chunkIndex = 0; i < docs.length; i += WRITE_BATCH_LIMIT, chunkIndex += 1) {
    const chunk = docs.slice(i, i + WRITE_BATCH_LIMIT);
    const batch = db.batch();
    for (const { ref } of chunk) batch.update(ref, { role: 'crew' });

    try {
      await batch.commit();
      committed += chunk.length;
      console.log(
        `  ${label}: chunk ${chunkIndex + 1}/${totalChunks} committed (${chunk.length} docs, ${committed}/${docs.length} total)`,
      );
    } catch (err) {
      console.error(
        `  ${label}: FAILED committing chunk ${chunkIndex + 1}/${totalChunks} — ` +
          `${committed}/${docs.length} docs already committed before the failure`,
      );
      throw err;
    }
  }

  return committed;
}

// ── Auth pass ────────────────────────────────────────────────────────────────

/**
 * For each uid, re-reads its CURRENT custom claims (not the Firestore role
 * just migrated — the claim is the independent source of truth a session
 * actually carries) and, only if that claim's `role` is exactly `'viewer'`,
 * spreads the existing claims and re-sets with `role: 'crew'`. A uid whose
 * claim is already something else (including already `'crew'`, or an
 * account with no claims at all) is left untouched and counted separately.
 */
async function migrateAuthClaims(uids) {
  let updated = 0;
  let alreadyOk = 0;
  let failed = 0;

  for (const uid of uids) {
    try {
      const user = await auth.getUser(uid);
      const existing = user.customClaims ?? {};
      if (existing.role !== 'viewer') {
        alreadyOk += 1;
        continue;
      }
      await auth.setCustomUserClaims(uid, { ...existing, role: 'crew' });
      updated += 1;
    } catch (err) {
      failed += 1;
      console.error(`  FAILED updating Auth claims for uid ${uid}: ${err.message}`);
    }
  }

  return { updated, alreadyOk, failed };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const mode = APPLY ? 'APPLY (writes)' : 'DRY RUN (read-only)';

  console.log('');
  console.log(`  Project : ${projectId}`);
  console.log(`  Auth    : ${credentialSource}`);
  console.log(`  Mode    : ${mode}`);
  console.log('');

  const memberDocs = await findLegacyViewerDocs('members', (doc) => doc.id);
  const membershipDocs = await findLegacyViewerDocs('memberships', (doc) => {
    // users/{uid}/memberships/{companyId} — uid is the grandparent segment.
    const parent = doc.ref.parent.parent;
    return parent ? parent.id : null;
  });
  const invitationDocs = await findLegacyViewerDocs('invitations', () => null);

  const affectedUids = new Set();
  for (const { uid } of memberDocs) if (uid) affectedUids.add(uid);
  for (const { uid } of membershipDocs) if (uid) affectedUids.add(uid);

  console.log('  ── Firestore: role == \'viewer\' found ──────────────────────────────');
  console.log(`  companies/*/members/*      : ${memberDocs.length}`);
  console.log(`  users/*/memberships/*      : ${membershipDocs.length}`);
  console.log(`  companies/*/invitations/*  : ${invitationDocs.length}`);
  console.log(`  Distinct uids affected (members + memberships) : ${affectedUids.size}`);
  console.log('');

  if (!APPLY) {
    console.log('  Dry run only — no writes made. Re-run with --yes to apply.');
    console.log('');
    const sample = (docs) => docs.slice(0, 10).map((d) => `    ${d.path}`).join('\n');
    if (memberDocs.length) console.log(`  Sample members docs:\n${sample(memberDocs)}`);
    if (membershipDocs.length) console.log(`  Sample memberships docs:\n${sample(membershipDocs)}`);
    if (invitationDocs.length) console.log(`  Sample invitations docs:\n${sample(invitationDocs)}`);
    console.log('');
    return;
  }

  console.log('  ── Applying Firestore writes ────────────────────────────────────────');
  await migrateRoleField('companies/*/members/*', memberDocs);
  await migrateRoleField('users/*/memberships/*', membershipDocs);
  await migrateRoleField('companies/*/invitations/*', invitationDocs);
  console.log('');

  console.log('  ── Applying Auth Custom Claims ──────────────────────────────────────');
  const { updated, alreadyOk, failed } = await migrateAuthClaims([...affectedUids]);
  console.log(`  Claim role updated viewer -> crew : ${updated}`);
  console.log(`  Claim already not 'viewer' (skipped) : ${alreadyOk}`);
  console.log(`  Failed to read/update : ${failed}`);
  console.log('');
  console.log('  Done. No refresh tokens were revoked — a stale viewer claim');
  console.log('  already normalises to crew on read (lib/dal.ts, issue #398).');
  console.log('');
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
