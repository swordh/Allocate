/**
 * Migration: Normalize equipment unit status values.
 *
 * Transforms:
 *   status: 'available'     -> 'ok'
 *   status: 'checked_out'   -> 'limited_operations'
 *   status: 'needs_repair'  -> unchanged (left as-is)
 *
 * Scope: collectionGroup('units') across all companies/equipment.
 *
 * Run from the repo root:
 *   node tools/migrate_unit_status.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 1. Load .env.local manually (no dotenv dependency needed)
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
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    vars[key] = value;
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
// 2. Initialise Firebase Admin
// ---------------------------------------------------------------------------
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp({ credential: cert(serviceAccount) });

const db = getFirestore();

// ---------------------------------------------------------------------------
// 3. Status mapping
// ---------------------------------------------------------------------------
const STATUS_MAP = {
  available: 'ok',
  checked_out: 'limited_operations',
};

// ---------------------------------------------------------------------------
// 4. Migration
// ---------------------------------------------------------------------------
const BATCH_SIZE = 499; // Firestore batched write max is 500 operations

async function migrate() {
  console.log('Querying collectionGroup("units") for legacy status values...');

  const legacyStatuses = Object.keys(STATUS_MAP); // ['available', 'checked_out']

  // Fetch the full collection group without a filter to avoid needing a
  // composite index. We filter in memory — acceptable for a one-shot migration.
  const snapshot = await db.collectionGroup('units').get();

  if (snapshot.empty) {
    console.log('No units documents found at all. Nothing to migrate.');
    return;
  }

  console.log(`Total units docs fetched: ${snapshot.size}. Filtering for legacy statuses in memory...`);

  const docsToUpdate = snapshot.docs.filter((d) => {
    const s = d.data().status;
    return legacyStatuses.includes(s);
  });

  if (docsToUpdate.length === 0) {
    console.log('No documents with legacy status values found. Nothing to migrate.');
    return;
  }

  console.log(`Found ${docsToUpdate.length} document(s) to update.`);

  // Split into batches of BATCH_SIZE
  const docs = docsToUpdate;
  let totalUpdated = 0;
  let batchCount = 0;

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const chunk = docs.slice(i, i + BATCH_SIZE);
    const batch = db.batch();

    for (const docSnap of chunk) {
      const currentStatus = docSnap.data().status;
      const newStatus = STATUS_MAP[currentStatus];
      if (!newStatus) continue; // Defensive: skip if somehow not in map
      batch.update(docSnap.ref, { status: newStatus });
      console.log(
        `  [${docSnap.ref.path}]  ${currentStatus} -> ${newStatus}`
      );
    }

    await batch.commit();
    totalUpdated += chunk.length;
    batchCount++;
    console.log(`Batch ${batchCount} committed (${chunk.length} docs).`);
  }

  console.log(`\nMigration complete. ${totalUpdated} document(s) updated across ${batchCount} batch(es).`);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
