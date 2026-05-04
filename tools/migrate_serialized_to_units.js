/**
 * Migration: rename trackingType 'serialized' → 'units' (issue #172)
 *
 * Updates all equipment documents where trackingType === 'serialized' to 'units'.
 * Scope: companies/{companyId}/equipment/{equipmentId}
 *
 * Run from the repo root:
 *   node tools/migrate_serialized_to_units.js
 * Prerequisites: FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON in .env.local
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 1. Load .env.local (same pattern as migrate_unit_status.js)
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
// 2. Initialise Firebase Admin
// ---------------------------------------------------------------------------
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp({ credential: cert(serviceAccount) });

const db = getFirestore();

// ---------------------------------------------------------------------------
// 3. Constants
// ---------------------------------------------------------------------------
const BATCH_SIZE = 499;
const OLD_VALUE = 'serialized';
const NEW_VALUE = 'units';

// ---------------------------------------------------------------------------
// 4. Migration
// ---------------------------------------------------------------------------
async function migrate() {
  console.log(`Migration started: trackingType '${OLD_VALUE}' → '${NEW_VALUE}'`);
  console.log('Listing companies...');

  let companiesSnapshot;
  try {
    companiesSnapshot = await db.collection('companies').get();
  } catch (err) {
    console.error('ERROR: Failed to list companies collection:', err);
    process.exit(1);
  }

  if (companiesSnapshot.empty) {
    console.log('No company documents found. Nothing to migrate.');
    return;
  }

  console.log(`Found ${companiesSnapshot.size} company document(s).\n`);

  let totalUpdated = 0;
  let totalBatches = 0;

  for (const companyDoc of companiesSnapshot.docs) {
    const companyId = companyDoc.id;

    let equipmentSnapshot;
    try {
      equipmentSnapshot = await db
        .collection('companies')
        .doc(companyId)
        .collection('equipment')
        .get();
    } catch (err) {
      console.error(`  [${companyId}] ERROR: Failed to list equipment — skipping company:`, err);
      continue;
    }

    if (equipmentSnapshot.empty) {
      console.log(`  [${companyId}] No equipment documents — skipping.`);
      continue;
    }

    const docsToUpdate = equipmentSnapshot.docs.filter(
      (doc) => doc.data().trackingType === OLD_VALUE
    );

    if (docsToUpdate.length === 0) {
      console.log(
        `  [${companyId}] ${equipmentSnapshot.size} equipment doc(s) checked — 0 need updating.`
      );
      continue;
    }

    console.log(
      `  [${companyId}] ${equipmentSnapshot.size} equipment doc(s) checked — updating ${docsToUpdate.length}.`
    );

    for (let i = 0; i < docsToUpdate.length; i += BATCH_SIZE) {
      const chunk = docsToUpdate.slice(i, i + BATCH_SIZE);
      const batch = db.batch();

      for (const docSnap of chunk) {
        batch.update(docSnap.ref, { trackingType: NEW_VALUE });
      }

      try {
        await batch.commit();
        totalUpdated += chunk.length;
        totalBatches++;
        console.log(
          `    Batch ${totalBatches} committed: ${chunk.length} doc(s) updated for company '${companyId}'.`
        );
      } catch (err) {
        console.error(
          `    ERROR: Batch commit failed for company '${companyId}' (offset ${i}):`,
          err
        );
      }
    }
  }

  console.log(
    `\nMigration complete. ${totalUpdated} equipment document(s) updated across ${totalBatches} batch(es).`
  );
}

migrate().catch((err) => {
  console.error('Unhandled error — migration aborted:', err);
  process.exit(1);
});
