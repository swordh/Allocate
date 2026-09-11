/**
 * One-off cleanup: delete orphaned companies/{cid}/members/{uid} docs.
 *
 * Background: actions/account.ts `deleteAccount` deletes users/{uid} and
 * users/{uid}/memberships/{cid} but, before the fix in this branch, never
 * deleted companies/{cid}/members/{uid}. That doc carries the deleted user's
 * name and email, and firestore.rules:84's `companies/{companyId}/{document=**}`
 * wildcard makes it readable by every remaining member of the company — a
 * GDPR Art. 17 leak for anyone who deleted their account before the fix
 * shipped. This script finds and removes those leftover docs across
 * environments that predate the fix.
 *
 * An orphan is a companies/{cid}/members/{memberDocId} whose matching
 * users/{memberDocId} does not exist AND whose joinedAt is older than the
 * 15-minute safety window below (see SAFETY_WINDOW_MS) — a brand-new member
 * created via acceptInvitationByToken can legitimately be in this state for
 * a moment. A member doc with no joinedAt at all is never auto-deleted; it
 * is reported separately as "skipped — no joinedAt" for a human to check.
 *
 * Usage, from the repo root:
 *   node tools/cleanup_orphan_members.js --project=allocate-alpha             # dry run
 *   node tools/cleanup_orphan_members.js --project=allocate-alpha --yes       # apply
 *   node tools/cleanup_orphan_members.js --project=allocate-beta             # dry run
 *   node tools/cleanup_orphan_members.js --project=allocate-beta --yes       # apply
 *   node tools/cleanup_orphan_members.js --project=allocate-e0735            # dry run (prod)
 *   node tools/cleanup_orphan_members.js --project=allocate-e0735 --yes      # apply (prod)
 *
 *   node tools/cleanup_orphan_members.js --project=allocate-alpha --company=<id>  # one company
 *
 * Credentials, in resolution order:
 *   --project=<id>  Application Default Credentials. Preferred — no long-lived
 *                   key file on disk, and it reaches every project your gcloud
 *                   login can. Requires `gcloud auth application-default login`
 *                   once.
 *   --sa=<path>     an explicit service account key file.
 *   neither         FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON from .env.local, which
 *                   only ever points at one project.
 *
 * --dry-run is the DEFAULT. Nothing is written unless --yes is passed.
 * The script is idempotent: a member doc already removed just won't show up
 * as an orphan on the next run.
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
const ONLY_COMPANY = value('company');
const SA_PATH = value('sa');
const PROJECT = value('project');
const CONCURRENCY = 5;
const PAGE_SIZE = 200;
const DELETE_BATCH_LIMIT = 490;

// functions/src/auth/acceptInvitation.ts's acceptInvitationByToken creates
// companies/{cid}/members/{uid} inside a transaction, then writes
// users/{uid} AFTERWARDS and non-transactionally (`await userRef.set(...)`,
// outside the transaction). Between those two writes a perfectly legitimate,
// brand-new member doc exists with no matching users/{uid} doc yet — exactly
// what this script otherwise calls an orphan. (onUserCreate.ts does not have
// this window: it writes both docs inside one transaction.) Requiring
// joinedAt to be older than this window before treating a member as an
// orphan keeps a slow signup from being deleted mid-flight.
const SAFETY_WINDOW_MS = 15 * 60 * 1000;

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

// ── Enumeration ──────────────────────────────────────────────────────────────

async function* companyIds() {
  if (ONLY_COMPANY) {
    yield ONLY_COMPANY;
    return;
  }
  let cursor = null;
  for (;;) {
    let q = db.collection('companies').select().orderBy('__name__').limit(PAGE_SIZE);
    // Pass the snapshot itself, not the id — with __name__ ordering Firestore
    // expects a reference, and a bare id string silently paginates wrong.
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    for (const doc of snap.docs) yield doc.id;
    if (snap.size < PAGE_SIZE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

async function* chunks(iterable, size) {
  const out = [];
  for await (const item of iterable) {
    out.push(item);
    if (out.length === size) {
      yield out.splice(0, size);
    }
  }
  if (out.length) yield out;
}

// ── Per-company orphan detection ────────────────────────────────────────────

/**
 * Classifies member docs for one company into three buckets: `orphans`
 * (no matching users/{id}, joinedAt older than SAFETY_WINDOW_MS — safe to
 * delete), `heldBack` (no matching users/{id}, but joinedAt is inside the
 * safety window — likely a signup still in flight, not deleted), and
 * `noJoinedAt` (no matching users/{id} and no joinedAt field at all — too
 * risky to auto-classify either way, never deleted, always reported).
 *
 * `.select('name', 'email', 'joinedAt')` on the members query pulls only
 * those fields (plus doc metadata) instead of whole documents — cheap, and
 * it's exactly the data the dry-run report and the safety-window check
 * need, so there's no separate lightweight pass followed by a second
 * full-document fetch. The existence check against users/{id} still has to
 * be a real `.get()` per candidate (Firestore has no way to test existence
 * via `.select()`), so it's done with `Promise.all` across the page rather
 * than serially.
 *
 * joinedAt is written as a Firestore Timestamp by all three writers
 * (acceptInvitation.ts and onUserCreate.ts via `Timestamp.now()`,
 * actions/auth.ts via `FieldValue.serverTimestamp()`, which reads back as a
 * Timestamp) — so `.toMillis()` is safe across all of them once the field
 * is present at all.
 */
async function classifyMembers(companyId) {
  const membersSnap = await db
    .collection(`companies/${companyId}/members`)
    .select('name', 'email', 'joinedAt')
    .get();

  const orphans = [];
  const heldBack = [];
  const noJoinedAt = [];

  if (membersSnap.empty) return { orphans, heldBack, noJoinedAt };

  const now = Date.now();

  await Promise.all(
    membersSnap.docs.map(async (memberDoc) => {
      const userSnap = await db.collection('users').doc(memberDoc.id).get();
      if (userSnap.exists) return;

      const entry = {
        companyId,
        memberDocId: memberDoc.id,
        name: memberDoc.get('name') ?? null,
        email: memberDoc.get('email') ?? null,
        ref: memberDoc.ref,
      };

      const joinedAt = memberDoc.get('joinedAt');
      if (!joinedAt || typeof joinedAt.toMillis !== 'function') {
        noJoinedAt.push(entry);
        return;
      }

      const ageMs = now - joinedAt.toMillis();
      if (ageMs < SAFETY_WINDOW_MS) {
        heldBack.push({ ...entry, ageMs });
        return;
      }

      orphans.push(entry);
    }),
  );

  return { orphans, heldBack, noJoinedAt };
}

// ── Delete ───────────────────────────────────────────────────────────────────

/**
 * Deletes orphans in chunks of DELETE_BATCH_LIMIT. If a commit throws partway
 * through (e.g. the 2nd of 3 chunks), the chunks committed so far already
 * happened — the caller needs to know that before the error propagates, or
 * a report saying "0 deleted" would be a lie. So progress is printed here,
 * per chunk, rather than left to the top-level summary that never runs on
 * a thrown error.
 */
async function deleteOrphans(orphans) {
  const chunkCount = Math.ceil(orphans.length / DELETE_BATCH_LIMIT);
  let deleted = 0;

  for (let i = 0; i < orphans.length; i += DELETE_BATCH_LIMIT) {
    const chunk = orphans.slice(i, i + DELETE_BATCH_LIMIT);
    const chunkIndex = i / DELETE_BATCH_LIMIT + 1;
    const batch = db.batch();
    for (const orphan of chunk) batch.delete(orphan.ref);

    try {
      await batch.commit();
      deleted += chunk.length;
      console.log(`  deleted chunk ${chunkIndex}/${chunkCount} (${chunk.length} docs, ${deleted}/${orphans.length} total)`);
    } catch (err) {
      console.error(`  FAILED on chunk ${chunkIndex}/${chunkCount} — ${deleted}/${orphans.length} deleted before the failure`);
      throw err;
    }
  }

  return deleted;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const mode = APPLY ? 'APPLY (writes)' : 'DRY RUN (read-only)';

  console.log('');
  console.log(`  Project : ${projectId}`);
  console.log(`  Auth    : ${credentialSource}`);
  console.log(`  Mode    : ${mode}`);
  if (ONLY_COMPANY) console.log(`  Company : ${ONLY_COMPANY}`);
  console.log(`  Safety window: ${SAFETY_WINDOW_MS / 60000} min (members newer than this are held back, never auto-deleted)`);
  console.log('');

  // Count companies up front so the operator knows the scope before anything runs.
  const allCompanyIds = [];
  for await (const id of companyIds()) allCompanyIds.push(id);
  console.log(`  ${allCompanyIds.length} ${allCompanyIds.length === 1 ? 'company' : 'companies'} to scan`);
  console.log('');

  const companyNameCache = new Map();
  const getCompanyName = async (companyId) => {
    if (companyNameCache.has(companyId)) return companyNameCache.get(companyId);
    const snap = await db.collection('companies').doc(companyId).select('name').get();
    const name = snap.get('name') || '(unnamed)';
    companyNameCache.set(companyId, name);
    return name;
  };

  let scanned = 0;
  let totalDeleted = 0;
  const allOrphans = [];
  const allHeldBack = [];
  const allNoJoinedAt = [];

  for (const batchOfIds of chunkArray(allCompanyIds, CONCURRENCY)) {
    await Promise.all(
      batchOfIds.map(async (companyId) => {
        scanned += 1;
        const { orphans, heldBack, noJoinedAt } = await classifyMembers(companyId);
        if (orphans.length === 0 && heldBack.length === 0 && noJoinedAt.length === 0) return;

        const companyName = await getCompanyName(companyId);
        for (const entry of orphans) {
          entry.companyName = companyName;
          allOrphans.push(entry);
        }
        for (const entry of heldBack) {
          entry.companyName = companyName;
          allHeldBack.push(entry);
        }
        for (const entry of noJoinedAt) {
          entry.companyName = companyName;
          allNoJoinedAt.push(entry);
        }
      }),
    );
  }

  const totalOrphans = allOrphans.length;

  const printTable = (rows) => {
    console.log('  company id                      company name              member doc id                   name                  email');
    for (const o of rows) {
      console.log(
        `  ${pad(o.companyId, 30)}  ${pad(o.companyName, 24)}  ${pad(o.memberDocId, 30)}  ${pad(o.name ?? '—', 20)}  ${o.email ?? '—'}`,
      );
    }
  };

  if (totalOrphans === 0) {
    console.log('  No orphaned member docs found.');
  } else {
    console.log(`  Found ${totalOrphans} orphaned member ${totalOrphans === 1 ? 'doc' : 'docs'}:`);
    console.log('');
    printTable(allOrphans);

    if (APPLY) {
      totalDeleted = await deleteOrphans(allOrphans);
    }
  }

  if (allHeldBack.length > 0) {
    console.log('');
    console.log(
      `  Held back — inside the ${SAFETY_WINDOW_MS / 60000}-minute safety window (${allHeldBack.length}, not deleted):`,
    );
    console.log('');
    printTable(allHeldBack);
  }

  if (allNoJoinedAt.length > 0) {
    console.log('');
    console.log(`  Skipped — no joinedAt (${allNoJoinedAt.length}, too risky to auto-classify, not deleted):`);
    console.log('');
    printTable(allNoJoinedAt);
  }

  console.log('');
  console.log(
    `  ${scanned} ${scanned === 1 ? 'company' : 'companies'} scanned, ${totalOrphans} orphan${totalOrphans === 1 ? '' : 's'}` +
      `${APPLY ? `, ${totalDeleted} deleted` : ''}, ${allHeldBack.length} held back, ${allNoJoinedAt.length} skipped (no joinedAt)`,
  );

  if (!APPLY && totalOrphans > 0) {
    console.log('');
    console.log('  Re-run with --yes to delete.');
  }
  console.log('');
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function pad(str, len) {
  const s = String(str);
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  // ADC failures surface at first use, not at initializeApp, so the message
  // arrives here rather than up front.
  if (PROJECT && /credential|authenticat|permission|PERMISSION_DENIED/i.test(err.message)) {
    console.error('');
    console.error('  Using application default credentials. If they are missing or lack access:');
    console.error('    gcloud auth application-default login');
    console.error(`    gcloud projects get-iam-policy ${projectId}   # check your access`);
  }
  process.exit(1);
});
