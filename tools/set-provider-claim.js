/**
 * One-off script: sets provider:true custom claim on a Firebase Auth user.
 *
 * Preserves existing claims (activeCompanyId, role) via spread.
 *
 * Run from the repo root:
 *   node tools/set-provider-claim.js user@example.com
 * Prerequisites: FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON in .env.local
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 1. Validate arguments
// ---------------------------------------------------------------------------

const email = process.argv[2];
if (!email) {
  console.error('ERROR: No email address provided.');
  console.error('Usage: node tools/set-provider-claim.js user@example.com');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Load .env.local
// ---------------------------------------------------------------------------

const ENV_PATH = path.resolve(__dirname, '../.env.local');

function loadEnvFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const vars = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    vars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return vars;
}

const env = loadEnvFile(ENV_PATH);
const serviceAccountJson = env['FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON'];
if (!serviceAccountJson) {
  console.error('ERROR: FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON not found in .env.local');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(serviceAccountJson);
} catch (err) {
  console.error('ERROR: Failed to parse FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON:', err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Initialise Firebase Admin
// ---------------------------------------------------------------------------

const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

initializeApp({ credential: cert(serviceAccount) });

const auth = getAuth();

// ---------------------------------------------------------------------------
// 4. Set claim
// ---------------------------------------------------------------------------

async function run() {
  console.log(`Looking up user: ${email}`);

  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(email);
  } catch (err) {
    console.error(`ERROR: Could not find user with email '${email}':`, err.message);
    process.exit(1);
  }

  const uid = userRecord.uid;
  console.log(`Found user UID: ${uid}`);

  // Preserve existing claims — never overwrite activeCompanyId or role.
  const existing = (await auth.getUser(uid)).customClaims ?? {};
  await auth.setCustomUserClaims(uid, { ...existing, provider: true });

  console.log(`\nSuccess: provider:true claim set on ${email} (${uid})`);
  console.log('Resulting claims:', { ...existing, provider: true });
}

run().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
