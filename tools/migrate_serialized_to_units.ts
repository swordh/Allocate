// Migration: rename trackingType 'serialized' → 'units' (issue #172)
// Run once with: npx ts-node tools/migrate_serialized_to_units.ts
// Prerequisites: GOOGLE_APPLICATION_CREDENTIALS set, or gcloud auth application-default login

'use strict';

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, WriteBatch } from 'firebase-admin/firestore';

// ---------------------------------------------------------------------------
// 1. Initialise Firebase Admin with Application Default Credentials
// ---------------------------------------------------------------------------
initializeApp({
  credential: applicationDefault(),
  projectId: 'allocate-e0735',
});

const db = getFirestore();
db.settings({ preferRest: false }); // use gRPC (default); remove if you hit auth issues with ADC

// ---------------------------------------------------------------------------
// 2. Constants
// ---------------------------------------------------------------------------
const BATCH_SIZE = 499; // Firestore batched write max is 500 operations
const OLD_VALUE = 'serialized';
const NEW_VALUE = 'units';

// ---------------------------------------------------------------------------
// 3. Migration
// ---------------------------------------------------------------------------
async function migrate(): Promise<void> {
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

    // Split into batches of BATCH_SIZE
    for (let i = 0; i < docsToUpdate.length; i += BATCH_SIZE) {
      const chunk = docsToUpdate.slice(i, i + BATCH_SIZE);
      const batch: WriteBatch = db.batch();

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
        // Continue to next batch rather than aborting the entire migration
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
