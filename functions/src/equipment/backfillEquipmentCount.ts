import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

/**
 * Admin-only migration: backfills the `_meta/equipmentCount` counter document
 * for every company. Must be run once before deploying the counter-based plan
 * limit enforcement (issue #94).
 *
 * ⚠️ Only run ONCE, before deploying the counter-enforced code, against a quiescent database.
 * Re-running after live traffic starts will overwrite the transactional counter with a stale snapshot.
 *
 * @security Callable only by Firebase Auth super-admins (users whose Auth
 *           record has `customClaims.superAdmin === true`). Rejecting all
 *           other callers ensures this migration cannot be triggered by
 *           regular company admins.
 *
 * @returns { companiesProcessed: number, countersWritten: number }
 */
export const backfillEquipmentCount = onCall(
  { region: 'europe-west1', cors: true, invoker: 'public' },
  async (request) => {
    // ── Auth guard ───────────────────────────────────────────────────────────
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in.');
    }

    // Verify the caller is a Firebase super-admin via their Auth custom claims.
    // Regular company admins must not be able to invoke this migration.
    const auth = getAuth();
    const callerRecord = await auth.getUser(request.auth.uid);
    const claims = callerRecord.customClaims as Record<string, unknown> | undefined;

    if (!claims?.superAdmin) {
      throw new HttpsError(
        'permission-denied',
        'This function is restricted to super-admins.',
      );
    }

    const db = getFirestore();

    // ── List all companies ───────────────────────────────────────────────────
    const companiesSnap = await db.collection('companies').get();

    let companiesProcessed = 0;
    let countersWritten = 0;

    for (const companyDoc of companiesSnap.docs) {
      const companyId = companyDoc.id;

      try {
        // Count active equipment for this company using the aggregation API.
        // This is intentionally outside a transaction — the migration is a
        // one-time backfill; slight inconsistency during the migration window
        // is acceptable because the new code will not deploy until after the
        // migration completes.
        const countSnap = await db
          .collection(`companies/${companyId}/equipment`)
          .where('active', '==', true)
          .count()
          .get();

        const count: number = countSnap.data().count;

        const counterRef = db.doc(`companies/${companyId}/_meta/equipmentCount`);
        await counterRef.set(
          { count, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );

        countersWritten++;

        logger.info('backfillEquipmentCount: counter written', {
          companyId,
          count,
        });
      } catch (err) {
        // Log the error but continue processing other companies so a single
        // failure does not abort the entire migration.
        logger.error('backfillEquipmentCount: failed for company', {
          companyId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      companiesProcessed++;
    }

    logger.info('backfillEquipmentCount: migration complete', {
      companiesProcessed,
      countersWritten,
    });

    return { companiesProcessed, countersWritten };
  },
);
