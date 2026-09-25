/**
 * READ-ONLY inventory of invitation-document anomalies (issues #256 and
 * #255).
 *
 * ── The bugs ─────────────────────────────────────────────────────────────
 * `inviteUsers` (actions/team.ts ~207-227) writes two documents per invited
 * address:
 *
 *   - private  `companies/{cid}/invitations/{id}` — the full record: id,
 *     email, role, invitedBy, invitedByName, invitedAt (ISO), status
 *     ('pending' | 'accepted' | 'revoked'), token, expiresAt (+ acceptedAt
 *     etc. added later by accept/revoke). `expiresAt` is optional on the
 *     type (types/invitation.ts) — "missing means never expires", kept for
 *     backward compat with invites written before expiry existed.
 *   - mirror   `invitations/{token}` — { companyId, inviteId, email,
 *     status, expiresAt }, resolved by the public /invite/{token} page and
 *     the accept callable.
 *
 * Issue #256: a legacy pending invite with no `expiresAt` never expires, so
 * it permanently consumes a seat that nothing will ever reclaim. This
 * script counts and lists exactly those (both the private doc and its
 * mirror), so the size of the problem can be scoped before deciding on a
 * migration/backfill.
 *
 * Issue #255: `role` on an invitation is never validated against the
 * allowed set (admin | crew | viewer) before being written or trusted at
 * accept time. This script counts private invites (any status) whose role
 * is missing or is not one of the three allowed values, and separately
 * counts pending invites with role 'viewer' (context for how the allowed
 * set is actually used today).
 *
 * ── What this script does and does not do ───────────────────────────────
 * READ-ONLY. There is no write path, no flag that enables one, and no
 * function in this file ever calls anything but `.get()`. It does not
 * repair, backfill, or delete anything — that is a separate, later step.
 *
 * It NEVER prints an email address or any other personal field. Output is
 * limited to Firestore paths (which contain only auto-generated ids and
 * tokens, not PII), statuses, dates, role values, and counts.
 *
 * Logic:
 *   1. One `db.collectionGroup('invitations').get()` — no filters, so no
 *      composite index is required.
 *   2. Split results in memory by path shape:
 *        - private = `companies/{cid}/invitations/{id}`  (4 segments)
 *        - mirror  = `invitations/{token}`                (2 segments)
 *        - anything else -> counted as "unexpected path" and otherwise
 *          ignored (collectionGroup('invitations') could in principle match
 *          a differently-shaped subcollection elsewhere; nothing else in
 *          this codebase has one today, but this script checks path shape
 *          explicitly rather than assuming).
 *   3. Cross-reference private <-> mirror by token (mirror doc id is the
 *      private doc's `token` field) to find orphans on either side.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *   node tools/inventory_invitations.js --project=allocate-alpha
 *   node tools/inventory_invitations.js --project=allocate-e0735
 *   node tools/inventory_invitations.js --sa=/path/to/service-account.json
 *   node tools/inventory_invitations.js   # falls back to .env.local
 *   node tools/inventory_invitations.js --project=allocate-alpha --json
 *
 * Credentials, in resolution order (same as tools/inventory_stranded_deletions.js):
 *   --project=<id>  Application Default Credentials.
 *   --sa=<path>     an explicit service account key file.
 *   neither         FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON from .env.local.
 * Passing both --project and --sa is an error.
 *
 * Output: a summary to stdout. With --json, the same data is printed as a
 * single JSON object instead of the plain-text report (still counts/paths
 * only, no PII, and still nothing is written to disk).
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

const ALLOWED_ROLES = new Set(['admin', 'crew', 'viewer']);

// ── Credentials (identical resolution to tools/inventory_stranded_deletions.js) ─

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

const truncateRole = (v) => {
  if (v === undefined) return '(missing)';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 32 ? `${s.slice(0, 32)}…` : s;
};

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const snap = await db.collectionGroup('invitations').get();

  const privateDocs = []; // { ref, path, companyId, id, data }
  const mirrorDocs = []; // { ref, path, token, data }
  let unexpectedPathCount = 0;
  const unexpectedPaths = [];

  for (const doc of snap.docs) {
    const segments = doc.ref.path.split('/');
    const data = doc.data();

    if (segments.length === 4 && segments[0] === 'companies' && segments[2] === 'invitations') {
      privateDocs.push({
        path: doc.ref.path,
        companyId: segments[1],
        id: segments[3],
        data,
      });
    } else if (segments.length === 2 && segments[0] === 'invitations') {
      mirrorDocs.push({
        path: doc.ref.path,
        token: segments[1],
        data,
      });
    } else {
      unexpectedPathCount += 1;
      unexpectedPaths.push(doc.ref.path);
    }
  }

  // ── Totals ────────────────────────────────────────────────────────────
  const byStatus = { private: {}, mirror: {} };
  for (const d of privateDocs) {
    const s = d.data.status ?? '(missing)';
    byStatus.private[s] = (byStatus.private[s] ?? 0) + 1;
  }
  for (const d of mirrorDocs) {
    const s = d.data.status ?? '(missing)';
    byStatus.mirror[s] = (byStatus.mirror[s] ?? 0) + 1;
  }

  // ── 1. Pending private invites without expiresAt (#256) ──────────────
  const privatePendingNoExpiry = privateDocs.filter(
    (d) => d.data.status === 'pending' && d.data.expiresAt === undefined,
  );

  // ── 2. Pending mirrors without expiresAt (#256) ───────────────────────
  const mirrorPendingNoExpiry = mirrorDocs.filter(
    (d) => d.data.status === 'pending' && d.data.expiresAt === undefined,
  );

  // ── 3. Private invites with missing/invalid role (#255) ──────────────
  const roleMissing = [];
  const roleInvalid = [];
  for (const d of privateDocs) {
    const role = d.data.role;
    if (role === undefined) {
      roleMissing.push(d);
    } else if (!ALLOWED_ROLES.has(role)) {
      roleInvalid.push(d);
    }
  }

  // ── 4. Pending private invites with role 'viewer' ─────────────────────
  const pendingViewer = privateDocs.filter((d) => d.data.status === 'pending' && d.data.role === 'viewer');

  // ── 5. Cross-reference private <-> mirror by token ────────────────────
  const mirrorByToken = new Map(mirrorDocs.map((d) => [d.token, d]));
  const privateByCompanyAndId = new Map(privateDocs.map((d) => [`${d.companyId}/${d.id}`, d]));

  const pendingPrivateNoMirror = privateDocs.filter(
    (d) => d.data.status === 'pending' && d.data.token !== undefined && !mirrorByToken.has(d.data.token),
  );

  const pendingMirrorNoPrivate = mirrorDocs.filter((d) => {
    if (d.data.status !== 'pending') return false;
    const companyId = d.data.companyId;
    const inviteId = d.data.inviteId;
    if (companyId === undefined || inviteId === undefined) return true; // can't resolve -> treat as orphan
    return !privateByCompanyAndId.has(`${companyId}/${inviteId}`);
  });

  const result = {
    project: projectId,
    credentialSource,
    totals: {
      private: privateDocs.length,
      mirror: mirrorDocs.length,
      unexpectedPath: unexpectedPathCount,
      byStatus,
    },
    issue256: {
      pendingPrivateNoExpiry: {
        count: privatePendingNoExpiry.length,
        items: privatePendingNoExpiry.map((d) => ({ path: d.path, invitedAt: d.data.invitedAt ?? null })),
      },
      pendingMirrorNoExpiry: {
        count: mirrorPendingNoExpiry.length,
        paths: mirrorPendingNoExpiry.map((d) => d.path),
      },
    },
    issue255: {
      roleMissing: {
        count: roleMissing.length,
        items: roleMissing.map((d) => ({ path: d.path, status: d.data.status ?? '(missing)', role: '(missing)' })),
      },
      roleInvalid: {
        count: roleInvalid.length,
        items: roleInvalid.map((d) => ({
          path: d.path,
          status: d.data.status ?? '(missing)',
          role: truncateRole(d.data.role),
        })),
      },
      pendingViewerCount: pendingViewer.length,
    },
    crossReference: {
      pendingPrivateNoMirror: {
        count: pendingPrivateNoMirror.length,
        paths: pendingPrivateNoMirror.map((d) => d.path),
      },
      pendingMirrorNoPrivate: {
        count: pendingMirrorNoPrivate.length,
        paths: pendingMirrorNoPrivate.map((d) => d.path),
      },
    },
    unexpectedPaths,
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
  console.log(`  Private invitation docs (companies/*/invitations/*) : ${privateDocs.length}`);
  console.log(`  Mirror invitation docs  (invitations/*)              : ${mirrorDocs.length}`);
  console.log(`  Unexpected-shape docs (neither private nor mirror)   : ${unexpectedPathCount}`);
  console.log('');
  console.log('  Private by status:', JSON.stringify(byStatus.private));
  console.log('  Mirror  by status:', JSON.stringify(byStatus.mirror));
  console.log('');

  console.log('  ── Issue #256: legacy invites that never expire ──────────────────');
  console.log(`  Pending private invites with no expiresAt : ${privatePendingNoExpiry.length}`);
  for (const d of privatePendingNoExpiry) {
    console.log(`    ${d.path}  invitedAt=${d.data.invitedAt ?? '(missing)'}`);
  }
  console.log(`  Pending mirrors with no expiresAt         : ${mirrorPendingNoExpiry.length}`);
  for (const d of mirrorPendingNoExpiry) {
    console.log(`    ${d.path}`);
  }
  console.log('');

  console.log('  ── Issue #255: unvalidated role ───────────────────────────────────');
  console.log(`  Private invites with role missing         : ${roleMissing.length}`);
  for (const d of roleMissing) {
    console.log(`    ${d.path}  status=${d.data.status ?? '(missing)'}  role=(missing)`);
  }
  console.log(`  Private invites with an invalid role value : ${roleInvalid.length}`);
  for (const d of roleInvalid) {
    console.log(`    ${d.path}  status=${d.data.status ?? '(missing)'}  role=${truncateRole(d.data.role)}`);
  }
  console.log(`  Pending private invites with role 'viewer' : ${pendingViewer.length}`);
  console.log('');

  console.log('  ── Cross-reference: private <-> mirror by token ───────────────────');
  console.log(`  Pending private invites with no matching mirror : ${pendingPrivateNoMirror.length}`);
  for (const p of pendingPrivateNoMirror.map((d) => d.path)) console.log(`    ${p}`);
  console.log(`  Pending mirrors with no matching private doc    : ${pendingMirrorNoPrivate.length}`);
  for (const p of pendingMirrorNoPrivate.map((d) => d.path)) console.log(`    ${p}`);
  console.log('');

  if (unexpectedPathCount > 0) {
    console.log('  ── Unexpected-shape paths ──────────────────────────────────────────');
    for (const p of unexpectedPaths) console.log(`    ${p}`);
    console.log('');
  }
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
