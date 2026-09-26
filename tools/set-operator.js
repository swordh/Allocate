/**
 * Manages `operators/{uid}` in Firestore — issue #344's replacement for the
 * `provider:true` custom claim + hardcoded `OPERATOR_ALLOWLIST` that used to
 * gate `/operator/**` (see lib/operator-dal.ts's `isOperator` docblock for
 * why those were rejected). Operator status now lives entirely in Firestore
 * and is checked with the Admin SDK on every request — granting or revoking
 * access here takes effect on that uid's very next request, no deploy, no
 * waiting out a 14-day session cookie.
 *
 * Replaces tools/set-provider-claim.js (deleted).
 *
 * ── Usage, from the repo root ────────────────────────────────────────────
 *   node tools/set-operator.js grant --email=jocke@allocate.at --project=allocate-alpha            # dry run
 *   node tools/set-operator.js grant --email=jocke@allocate.at --project=allocate-alpha --yes       # apply
 *   node tools/set-operator.js revoke --email=jocke@allocate.at --project=allocate-alpha --yes
 *   node tools/set-operator.js list --project=allocate-alpha
 *
 *   node tools/set-operator.js grant --email=jocke@allocate.at --sa=./service-account.json --yes
 *   node tools/set-operator.js grant --email=jocke@allocate.at --yes   # .env.local fallback
 *
 *   # Also strip the legacy provider:true claim while granting/revoking,
 *   # preserving every other existing claim:
 *   node tools/set-operator.js revoke --email=jocke@allocate.at --project=allocate-alpha --strip-provider-claim --yes
 *
 * --dry-run is the DEFAULT for grant/revoke. Nothing is written unless
 * --yes is passed. `list` is always read-only.
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
 * Passing both --project and --sa is refused — one source only, silently
 * preferring one over the other is how you end up writing to the wrong
 * project.
 *
 * When both --project and a service-account credential are known (--sa, or
 * the .env.local fallback), the credential's own `project_id` is checked
 * against --project and the run is refused on a mismatch — see the
 * reasoning in tools/seed-noplan-company.js (~L365-381): `initializeApp`'s
 * `projectId` option does not redirect the Auth SDK, so a mismatched
 * credential can silently touch the wrong project's Auth users while this
 * script's own Firestore writes still (correctly) target `--project`.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Arguments ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const SUBCOMMAND = args.find((a) => !a.startsWith('--'));
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const APPLY = flag('yes');
const STRIP_PROVIDER_CLAIM = flag('strip-provider-claim');
const SA_PATH = value('sa');
const PROJECT = value('project');
const EMAIL = value('email');

if (!['grant', 'revoke', 'list'].includes(SUBCOMMAND)) {
  console.error('ERROR: usage: node tools/set-operator.js <grant|revoke|list> [--email=] [--project=|--sa=] [--yes] [--strip-provider-claim]');
  process.exit(1);
}

if ((SUBCOMMAND === 'grant' || SUBCOMMAND === 'revoke') && !EMAIL) {
  console.error(`ERROR: --email= is required for '${SUBCOMMAND}'.`);
  process.exit(1);
}

// One source only. Silently preferring one over the other is how you end up
// writing to the wrong project.
if (PROJECT && SA_PATH) {
  console.error('ERROR: pass either --project or --sa, not both.');
  process.exit(1);
}

// ── Credentials (same resolution as tools/migrate_viewer_to_crew.js) ─────────

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
const { getAuth } = require('firebase-admin/auth');

let projectId;
let credentialSource;
let serviceAccount = null;

if (PROJECT) {
  projectId = PROJECT;
  credentialSource = 'application default credentials';
  initializeApp({ credential: applicationDefault(), projectId });
} else {
  serviceAccount = SA_PATH ? readServiceAccountFile(SA_PATH) : readServiceAccountFromEnv();
  projectId = serviceAccount.project_id;
  credentialSource = SA_PATH ? `service account file ${SA_PATH}` : 'service account from .env.local';
  initializeApp({ credential: cert(serviceAccount) });
}

// Guard: when BOTH --project and a service-account credential are known,
// verify they agree before doing anything. See this file's module docblock
// and tools/seed-noplan-company.js (~L365-381) for why a mismatch here is
// dangerous specifically for Auth operations (grant/revoke both call
// getAuth().getUserByEmail()), even though the Firestore side would still
// (correctly) target --project regardless.
if (PROJECT && serviceAccount && serviceAccount.project_id !== PROJECT) {
  console.error(
    `ERROR: --project=${PROJECT} does not match the credential's project_id ` +
    `(${serviceAccount.project_id}). Auth operations run against the CREDENTIAL's ` +
    `project, not --project — refusing to risk touching the wrong project's users.`,
  );
  process.exit(1);
}

const db = getFirestore();
const auth = getAuth();

console.log('');
console.log(`  Project   : ${projectId}`);
console.log(`  Auth      : ${credentialSource}`);
console.log(`  Subcommand: ${SUBCOMMAND}`);
if (SUBCOMMAND !== 'list') {
  console.log(`  Mode      : ${APPLY ? 'APPLY (writes)' : 'DRY RUN (read-only)'}`);
}
console.log('');

// ── Subcommands ──────────────────────────────────────────────────────────────

async function grant() {
  const user = await auth.getUserByEmail(EMAIL);
  console.log(`  Found user: ${EMAIL} (${user.uid})`);

  if (!APPLY) {
    console.log(`  Dry run — would set operators/${user.uid} = { email: '${EMAIL}', grantedAt: <server timestamp> }`);
    if (STRIP_PROVIDER_CLAIM) {
      console.log('  Dry run — would also strip the legacy provider claim, preserving other claims.');
    }
    console.log('  Re-run with --yes to apply.');
    return;
  }

  await db.collection('operators').doc(user.uid).set({
    email: EMAIL,
    grantedAt: FieldValue.serverTimestamp(),
  });
  console.log(`  operators/${user.uid} written.`);

  if (STRIP_PROVIDER_CLAIM) {
    await stripProviderClaim(user.uid);
  }
}

async function revoke() {
  const user = await auth.getUserByEmail(EMAIL);
  console.log(`  Found user: ${EMAIL} (${user.uid})`);

  if (!APPLY) {
    console.log(`  Dry run — would delete operators/${user.uid}`);
    if (STRIP_PROVIDER_CLAIM) {
      console.log('  Dry run — would also strip the legacy provider claim, preserving other claims.');
    }
    console.log('  Re-run with --yes to apply.');
    return;
  }

  await db.collection('operators').doc(user.uid).delete();
  console.log(`  operators/${user.uid} deleted.`);

  if (STRIP_PROVIDER_CLAIM) {
    await stripProviderClaim(user.uid);
  }
}

/**
 * Removes the legacy `provider` custom claim from a user's Auth record
 * while preserving every other existing claim (activeCompanyId, role) —
 * same spread pattern tools/set-provider-claim.js used to set it.
 * Best-effort helper, not required for the operators/{uid} gate to work
 * correctly on its own; a stale `provider:true` claim left in place is
 * harmless once lib/operator-dal.ts no longer reads it, but this cleans it
 * up so it doesn't linger and confuse a future reader of the claims.
 */
async function stripProviderClaim(uid) {
  const user = await auth.getUser(uid);
  const existing = user.customClaims ?? {};
  if (!('provider' in existing)) {
    console.log(`  No 'provider' claim present on ${uid} — nothing to strip.`);
    return;
  }
  const rest = { ...existing };
  delete rest.provider;
  await auth.setCustomUserClaims(uid, rest);
  console.log(`  'provider' claim removed from ${uid}. Remaining claims:`, rest);
}

async function list() {
  const snap = await db.collection('operators').get();
  if (snap.empty) {
    console.log('  No operators.');
    return;
  }
  console.log(`  ${snap.size} operator(s):`);
  for (const doc of snap.docs) {
    const data = doc.data();
    const grantedAt = data.grantedAt && data.grantedAt.toDate ? data.grantedAt.toDate().toISOString() : String(data.grantedAt);
    console.log(`    ${doc.id}  ${data.email ?? '(no email)'}  grantedAt=${grantedAt}`);
  }
}

async function main() {
  if (SUBCOMMAND === 'grant') return grant();
  if (SUBCOMMAND === 'revoke') return revoke();
  return list();
}

main()
  .then(() => console.log(''))
  .catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
