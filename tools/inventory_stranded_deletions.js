/**
 * READ-ONLY inventory of users stranded by the issue #347 bug (issue #357,
 * step 1 of "Att göra").
 *
 * ── The bug ──────────────────────────────────────────────────────────────
 * Before #347 was fixed, `deleteAccount` (actions/account.ts) could fail
 * deterministically between its two Firestore-writing phases:
 *
 *   Step 2 (commit loop) — one `runTransaction` PER COMPANY, committed
 *     immediately, deletes `companies/{cid}/members/{uid}`.
 *   Step 3 (anonymisation batch) — a single chunked `WriteBatch`, committed
 *     only at the end, deletes `users/{uid}/memberships/{cid}` for every
 *     company (actions/account.ts ~line 892).
 *
 * If the process died after step 2 committed but before step 3's batch
 * committed, the company-side member doc was gone but the user-side
 * membership pointer survived — a "half-deleted" user: no longer a member
 * of the company, but still pointing at it, with `users/{uid}` and the
 * Firebase Auth record both untouched and no `deletionAuditLog` entry at
 * all. That is the exact signature this script searches for.
 *
 * ── False-positive check (done before writing this script) ─────────────
 * Every OTHER path that ends a membership was read to see whether it
 * could produce the same signature (company exists, member doc missing,
 * user-side pointer present):
 *
 *   - `removeMember` (actions/team.ts ~line 637-661) and `leaveCompany`
 *     (actions/team.ts ~line 802-834) each delete BOTH
 *     `companies/{cid}/members/{uid}` AND `users/{uid}/memberships/{cid}`
 *     inside the SAME `runTransaction` call — atomic, so neither can ever
 *     leave the signature behind, not even under a mid-transaction crash.
 *   - `cleanupOneMember` (functions/src/company/memberCleanup.ts), used by
 *     the company-deletion purge, deletes ONLY the user-side pointer
 *     (`users/{uid}/memberships/{companyId}`) and explicitly leaves
 *     `companies/{cid}/members/{uid}` for the purge's later "subtree phase"
 *     (`recursiveDelete` of the whole company). That is the OPPOSITE
 *     ordering from the bug — user-side goes first, company-side and the
 *     company document itself go together, later — so it can only ever
 *     produce a transient window with the member doc still present (not
 *     our signature) that resolves into the company being deleted entirely
 *     (which then falls into this script's separate "stale pointer"
 *     bucket, not "affected"), never into the affected signature itself.
 *   - The `mode: 'immediate'` branch inside `deleteAccount`'s own step 2
 *     (a company whose sole member is deleting her account) is the SAME
 *     step-2/step-3 split as the general case above and produces the same
 *     signature under the same failure — it is not a separate source, just
 *     the same bug reachable through a second branch.
 *
 * Conclusion: every occurrence of the signature this script finds is
 * either (a) a user genuinely stranded by the #347 bug, or (b) — in
 * principle, vanishingly rarely, and only if this script's read hits mid
 * flight — a "mode: immediate" deletion whose company purge is still in
 * progress. This script cannot distinguish those two after the fact from a
 * single read; if it matters, re-run and see whether the count is stable.
 *
 * ── What this script does and does not do ───────────────────────────────
 * READ-ONLY. There is no write path, no flag that enables one, and no
 * function in this file ever calls anything but `.get()`. It does not
 * repair anything — repair is a separate, later step per the issue.
 *
 * Logic:
 *   1. `collectionGroup('memberships')`, filtered down to docs whose path
 *      matches `users/{uid}/memberships/{cid}` (a collection group named
 *      "memberships" could in principle exist elsewhere; this script
 *      checks the parent path segments rather than assuming).
 *   2. For each such pointer, check whether `companies/{cid}` exists.
 *        - Missing entirely  -> STALE POINTER (a separate, non-#347 issue:
 *          the company is gone outright, not half-deleted). Counted
 *          separately, never mixed into "affected".
 *        - Exists AND `companies/{cid}/members/{uid}` is ALSO missing
 *          -> AFFECTED (the signature above).
 *        - Exists AND the member doc exists -> healthy, not counted.
 *   3. For each affected uid, also check whether `users/{uid}` exists and
 *      whether the Firebase Auth user exists (`getUser`; NotFound -> false).
 *
 * Reads are batched with `getAll` per chunk rather than one `.get()` per
 * document, to keep this from being O(n) round trips against Firestore.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *   node tools/inventory_stranded_deletions.js --project=allocate-alpha
 *   node tools/inventory_stranded_deletions.js --project=allocate-e0735
 *   node tools/inventory_stranded_deletions.js --sa=/path/to/service-account.json
 *   node tools/inventory_stranded_deletions.js   # falls back to .env.local
 *
 * Credentials, in resolution order (same as tools/backfill_company_stats.js):
 *   --project=<id>  Application Default Credentials.
 *   --sa=<path>     an explicit service account key file.
 *   neither         FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON from .env.local.
 * Passing both --project and --sa is an error.
 *
 * Output: a summary to stdout (counts only, uids truncated to 8 chars) and
 * the full uid list (per bucket) to
 * `.tmp/inventory_357_<project>_<YYYY-MM-DD>.json` — disposable, gitignored,
 * never committed.
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

const SA_PATH = value('sa');
const PROJECT = value('project');
const PAGE_SIZE = 500; // collectionGroup query page size
const GETALL_CHUNK = 300; // Firestore getAll() practical batch size

// ── Credentials (identical resolution to tools/backfill_company_stats.js) ────

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

const truncate = (uid) => `${uid.slice(0, 8)}...`;

// ── Step 1: enumerate every users/{uid}/memberships/{cid} pointer ──────────
//
// collectionGroup('memberships') can in principle match a differently
// shaped subcollection elsewhere named "memberships" — nothing else in this
// codebase has one today, but this script checks path shape explicitly
// rather than assuming, per the instructions.

async function* membershipPointers() {
  let cursor = null;
  for (;;) {
    let q = db.collectionGroup('memberships').orderBy('__name__').limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;

    for (const doc of snap.docs) {
      // Path must be exactly users/{uid}/memberships/{cid} (4 segments).
      const segments = doc.ref.path.split('/');
      if (segments.length !== 4 || segments[0] !== 'users' || segments[2] !== 'memberships') continue;

      yield {
        uid: segments[1],
        companyId: segments[3],
        joinedAt: doc.get('joinedAt') ?? null,
        ref: doc.ref,
      };
    }

    if (snap.size < PAGE_SIZE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

async function* chunked(iterable, size) {
  const out = [];
  for await (const item of iterable) {
    out.push(item);
    if (out.length === size) yield out.splice(0, size);
  }
  if (out.length) yield out;
}

// ── Step 2/3: classify pointers, then enrich affected uids ─────────────────

async function main() {
  console.log('');
  console.log(`  Project : ${projectId}`);
  console.log(`  Auth    : ${credentialSource}`);
  console.log(`  Mode    : READ-ONLY inventory (no writes exist in this script)`);
  console.log('');

  let totalPointers = 0;
  const affected = []; // { uid, companyId, joinedAt }
  let stalePointerCount = 0;
  const perCompanyAffected = new Map(); // companyId -> count

  for await (const batch of chunked(membershipPointers(), GETALL_CHUNK)) {
    totalPointers += batch.length;

    const companyRefs = batch.map((p) => db.doc(`companies/${p.companyId}`));
    const memberRefs = batch.map((p) => db.doc(`companies/${p.companyId}/members/${p.uid}`));

    // getAll() interleaves refs in one round trip; company doc and member
    // doc for the same pointer are read together for a consistent view.
    const allRefs = [];
    for (let i = 0; i < batch.length; i++) {
      allRefs.push(companyRefs[i], memberRefs[i]);
    }
    const snaps = await db.getAll(...allRefs);

    for (let i = 0; i < batch.length; i++) {
      const companySnap = snaps[i * 2];
      const memberSnap = snaps[i * 2 + 1];
      const pointer = batch[i];

      if (!companySnap.exists) {
        stalePointerCount += 1;
        continue;
      }

      if (!memberSnap.exists) {
        affected.push(pointer);
        perCompanyAffected.set(pointer.companyId, (perCompanyAffected.get(pointer.companyId) ?? 0) + 1);
      }
    }
  }

  // ── Enrich affected uids: users/{uid} existence + Auth existence ─────────
  const enriched = [];
  for (const batch of chunkArray(affected, GETALL_CHUNK)) {
    const userRefs = batch.map((p) => db.doc(`users/${p.uid}`));
    const userSnaps = await db.getAll(...userRefs);

    const authResults = await Promise.all(
      batch.map(async (p) => {
        try {
          await auth.getUser(p.uid);
          return true;
        } catch (err) {
          if (err && err.code === 'auth/user-not-found') return false;
          // Any other error (permissions, transient) — do not silently
          // report false; surface it and treat as unknown rather than
          // guessing. Read-only tool, so a thrown error here just aborts.
          throw err;
        }
      }),
    );

    for (let i = 0; i < batch.length; i++) {
      enriched.push({
        uid: batch[i].uid,
        companyId: batch[i].companyId,
        joinedAt: batch[i].joinedAt ? tsToIso(batch[i].joinedAt) : null,
        hasUserDoc: userSnaps[i].exists,
        hasAuthRecord: authResults[i],
      });
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`  Membership pointers scanned : ${totalPointers}`);
  console.log(`  Stale pointers (company gone entirely, not #347)  : ${stalePointerCount}`);
  console.log(`  Affected users (stranded by #347 signature)       : ${enriched.length}`);
  console.log('');

  if (perCompanyAffected.size > 0) {
    console.log('  Affected count per company:');
    for (const [companyId, count] of [...perCompanyAffected.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${companyId}: ${count}`);
    }
    console.log('');
  }

  const stillHaveUserDoc = enriched.filter((e) => e.hasUserDoc).length;
  const stillHaveAuth = enriched.filter((e) => e.hasAuthRecord).length;
  console.log(`  Still have users/{uid} doc      : ${stillHaveUserDoc} / ${enriched.length}`);
  console.log(`  Still have Firebase Auth record : ${stillHaveAuth} / ${enriched.length}`);

  const withJoinedAt = enriched.filter((e) => e.joinedAt).sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  if (withJoinedAt.length > 0) {
    console.log(`  Oldest membership pointer (joinedAt) among affected: ${withJoinedAt[0].joinedAt} (uid ${truncate(withJoinedAt[0].uid)})`);
  } else if (enriched.length > 0) {
    console.log('  No affected pointer carries a joinedAt field — cannot report an oldest hit.');
  }

  console.log('');
  if (enriched.length > 0) {
    console.log('  Affected uids (truncated):');
    for (const e of enriched) {
      console.log(
        `    ${truncate(e.uid)}  company=${e.companyId}  joinedAt=${e.joinedAt ?? 'unknown'}  userDoc=${e.hasUserDoc}  auth=${e.hasAuthRecord}`,
      );
    }
    console.log('');
  }

  // ── Full uid list to .tmp/, never committed ────────────────────────────────
  const tmpDir = path.resolve(__dirname, '../.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const outPath = path.join(tmpDir, `inventory_357_${projectId}_${date}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        project: projectId,
        generatedAt: new Date().toISOString(),
        totalPointersScanned: totalPointers,
        stalePointerCount,
        affectedCount: enriched.length,
        affected: enriched,
      },
      null,
      2,
    ),
  );
  console.log(`  Full uid list written to: ${outPath}`);
  console.log('');
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function tsToIso(v) {
  if (v && typeof v.toDate === 'function') return v.toDate().toISOString();
  return String(v);
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
