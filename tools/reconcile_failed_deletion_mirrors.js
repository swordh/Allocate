/**
 * Reconciles pre-#331 `companyDeletions` rows whose ledger is `failed` but
 * whose `companies/{companyId}.deletion.state` mirror was never flipped.
 *
 * ── The bug this repairs ────────────────────────────────────────────────
 * Before issue #331 shipped, `runCompanyPurge` (functions/src/company/
 * purge.ts) wrote `state: 'failed'` onto the `companyDeletions/{requestId}`
 * ledger alone — nothing ever touched the company document's own `deletion`
 * mirror. Every row that failed before `applyFailedTransition`
 * (functions/src/company/failDeletion.ts) started mirroring the state is
 * stuck with a company that still reads `deletion.state: 'executing'`
 * forever, which is exactly issue #331's original bug. New failures are
 * fixed going forward by `applyFailedTransition` itself; this script is the
 * one-time backfill for the ones that failed before that existed.
 *
 * It also backfills `failureReason`/`failedAt` onto the LEDGER row itself
 * when those are missing — pre-#331 rows never had them at all (the fields
 * didn't exist yet), so a row this script finds is, almost by construction,
 * missing them. `failureReason` is backfilled as `'attempts_exhausted'`
 * (the only way a row could ever reach `failed` before issue #335's
 * no-progress detection existed) and `failedAt` as the row's own
 * `lastHeartbeatAt` (the closest honest approximation of when it actually
 * stopped — `applyFailedTransition` itself uses `now` at the moment of the
 * transition, which this script cannot reconstruct after the fact).
 *
 * ── What this script does and does not do ───────────────────────────────
 * DRY-RUN BY DEFAULT. Pass `--apply` to actually write. Without it, this
 * only reads and prints what it WOULD change.
 *
 * No mail is ever sent — `applyFailedTransition`'s admin notification is a
 * live, "this just happened" mail, and these failures did not just happen;
 * mailing an admin about something that may be days or months old, with no
 * fresh context, would be confusing rather than helpful. An operator who
 * wants a company's admins told can still request that separately.
 *
 * Per row, in a TRANSACTION that re-reads both documents immediately before
 * writing (real Firestore state can have moved between this script's
 * initial scan and the write — e.g. an operator already requeued the row
 * by hand in the meantime):
 *   1. Re-check `companyDeletions/{requestId}.state === 'failed'` still
 *      holds.
 *   2. Re-check `companies/{companyId}` exists and its `deletion.requestId`
 *      still matches this ledger's `requestId` (same double guard
 *      `applyFailedTransition` uses — see that file's own docblock for why
 *      both matter).
 *   3. Re-check `companies/{companyId}.deletion.state !== 'failed'` — if it
 *      already says `failed` (fixed by something else since the scan),
 *      there is nothing to reconcile.
 *   4. Set the mirror's `deletion.state: 'failed'`, and backfill
 *      `failureReason`/`failedAt` on the LEDGER if either is missing.
 * A row that fails any re-check is skipped, not retried — this script is
 * meant to be re-run safely, and a row it skips this run because something
 * else already fixed it needs no further attention.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *   node tools/reconcile_failed_deletion_mirrors.js --project=allocate-alpha
 *   node tools/reconcile_failed_deletion_mirrors.js --project=allocate-alpha --apply
 *   node tools/reconcile_failed_deletion_mirrors.js --sa=/path/to/service-account.json
 *   node tools/reconcile_failed_deletion_mirrors.js   # falls back to .env.local
 *
 * Credentials, in resolution order (same as tools/inventory_stranded_deletions.js):
 *   --project=<id>  Application Default Credentials.
 *   --sa=<path>     an explicit service account key file.
 *   neither         FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON from .env.local.
 * Passing both --project and --sa is an error.
 *
 * Output: a summary to stdout — requestId, companyId, companyName (no
 * personal emails, no `requestedByName`/`requestedByEmail`, nothing from
 * `formerMemberContacts`) — for every row found, and for every row actually
 * written to when `--apply` is passed.
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
const APPLY = flag('apply');
const PAGE_SIZE = 300;

// ── Credentials (identical resolution to tools/inventory_stranded_deletions.js) ──

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
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

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

function tsToIso(v) {
  if (v && typeof v.toDate === 'function') return v.toDate().toISOString();
  return v ? String(v) : null;
}

// ── Step 1: every failed ledger row ─────────────────────────────────────────

async function* failedLedgers() {
  let cursor = null;
  for (;;) {
    let q = db.collection('companyDeletions').where('state', '==', 'failed').orderBy('__name__').limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    for (const doc of snap.docs) yield doc;
    if (snap.size < PAGE_SIZE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

// ── Step 2: reconcile one row, in its own transaction ───────────────────────

/** Returns 'fixed' | 'already_ok' | 'skipped' plus a `reason` for the latter two. */
async function reconcileOne(requestId) {
  return db.runTransaction(async (tx) => {
    const ledgerRef = db.doc(`companyDeletions/${requestId}`);
    const ledgerSnap = await tx.get(ledgerRef);
    if (!ledgerSnap.exists) return { status: 'skipped', reason: 'ledger no longer exists' };

    const ledger = ledgerSnap.data();
    if (ledger.state !== 'failed') return { status: 'skipped', reason: `ledger state is now '${ledger.state}'` };

    const companyId = ledger.companyId;
    if (!companyId) return { status: 'skipped', reason: 'ledger has no companyId' };

    const companyRef = db.doc(`companies/${companyId}`);
    const companySnap = await tx.get(companyRef);
    if (!companySnap.exists) return { status: 'skipped', reason: 'company document no longer exists' };

    const deletion = companySnap.data().deletion;
    if (!deletion || deletion.requestId !== requestId) {
      return { status: 'skipped', reason: 'mirror requestId does not match (a newer request has since overwritten it)' };
    }
    if (deletion.state === 'failed') {
      return { status: 'already_ok', reason: 'mirror already says failed' };
    }

    const ledgerBackfill = {};
    if (!ledger.failureReason) ledgerBackfill.failureReason = 'attempts_exhausted';
    if (!ledger.failedAt) ledgerBackfill.failedAt = ledger.lastHeartbeatAt ?? FieldValue.serverTimestamp();

    tx.update(companyRef, { 'deletion.state': 'failed' });
    if (Object.keys(ledgerBackfill).length > 0) tx.update(ledgerRef, ledgerBackfill);

    return { status: 'fixed', reason: null };
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log(`  Project : ${projectId}`);
  console.log(`  Auth    : ${credentialSource}`);
  console.log(`  Mode    : ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes — pass --apply to write)'}`);
  console.log('');

  const candidates = [];
  for await (const doc of failedLedgers()) {
    const d = doc.data();
    candidates.push({
      requestId: d.requestId ?? doc.id,
      companyId: d.companyId ?? '',
      companyName: d.companyName ?? '',
      lastHeartbeatAt: tsToIso(d.lastHeartbeatAt),
      failureReason: d.failureReason ?? null,
      failedAt: tsToIso(d.failedAt),
    });
  }

  console.log(`  Failed ledger rows scanned: ${candidates.length}`);
  console.log('');

  if (candidates.length === 0) {
    console.log('  Nothing to check. Done.');
    console.log('');
    return;
  }

  let fixed = 0;
  let alreadyOk = 0;
  let skipped = 0;
  const fixedRows = [];
  const skippedRows = [];

  for (const c of candidates) {
    if (APPLY) {
      const result = await reconcileOne(c.requestId);
      if (result.status === 'fixed') {
        fixed++;
        fixedRows.push(c);
      } else if (result.status === 'already_ok') {
        alreadyOk++;
      } else {
        skipped++;
        skippedRows.push({ ...c, reason: result.reason });
      }
    } else {
      // Dry-run: read-only preview of what --apply would attempt. Does not
      // run the transaction, so it cannot report a race that only a live
      // re-read would catch — that is exactly what --apply's own
      // re-checks are for.
      const companySnap = await db.doc(`companies/${c.companyId}`).get();
      if (!companySnap.exists) {
        skipped++;
        skippedRows.push({ ...c, reason: 'company document no longer exists' });
        continue;
      }
      const deletion = companySnap.data().deletion;
      if (!deletion || deletion.requestId !== c.requestId) {
        skipped++;
        skippedRows.push({ ...c, reason: 'mirror requestId does not match' });
        continue;
      }
      if (deletion.state === 'failed') {
        alreadyOk++;
        continue;
      }
      fixed++;
      fixedRows.push(c);
    }
  }

  console.log(`  Would ${APPLY ? '' : '(dry-run) '}fix mirror: ${fixed}`);
  console.log(`  Already OK               : ${alreadyOk}`);
  console.log(`  Skipped                  : ${skipped}`);
  console.log('');

  if (fixedRows.length > 0) {
    console.log(`  ${APPLY ? 'Fixed' : 'Would fix'} (requestId / companyId / companyName):`);
    for (const r of fixedRows) {
      console.log(`    ${r.requestId}  ${r.companyId}  ${r.companyName}`);
    }
    console.log('');
  }

  if (skippedRows.length > 0) {
    console.log('  Skipped (requestId / companyId / companyName / reason):');
    for (const r of skippedRows) {
      console.log(`    ${r.requestId}  ${r.companyId}  ${r.companyName}  — ${r.reason}`);
    }
    console.log('');
  }

  if (!APPLY && fixed > 0) {
    console.log(`  Re-run with --apply to write these ${fixed} mirror(s).`);
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
