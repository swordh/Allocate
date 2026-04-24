import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { getFirestore, FieldValue, WriteBatch } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { createHash } from 'crypto';

const BATCH_LIMIT = 490;

async function commitAndReset(batch: WriteBatch, db: ReturnType<typeof getFirestore>): Promise<WriteBatch> {
  await batch.commit();
  return db.batch();
}

/**
 * deleteAccount — GDPR Art. 17 Right to Erasure
 *
 * Permanently deletes the calling user's account and anonymizes all their
 * personal data across every company they belonged to.
 *
 * Anonymized fields (set to null):
 *   bookings:  userId, cancelledBy, approverId
 *   equipment: createdBy, approverId
 *   units:     createdBy, updatedBy, deactivatedBy
 *   companies: createdBy
 *
 * Sole-admin check blocks deletion if the user is the only admin in any
 * company — the company would be left unmanageable.
 *
 * Required Firestore indexes (firestore.indexes.json):
 *   collectionGroup memberships: companyId ASC, role ASC
 *   collectionGroup bookings:    userId ASC
 */
export const deleteAccount = onCall({ region: 'europe-west1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in.');
  }

  const uid = request.auth.uid;
  const db = getFirestore();

  // ── 1. Fetch user's company memberships ────────────────────────────────────
  const membershipsSnap = await db.collection(`users/${uid}/memberships`).get();
  const companyIds = membershipsSnap.docs.map((d) => d.data().companyId as string).filter(Boolean);

  // ── 2. Sole-admin check ────────────────────────────────────────────────────
  // Block if the user is the only admin in any company. Must be done before
  // any writes so the state is consistent if we throw.
  for (const companyId of companyIds) {
    const isAdmin = request.auth.token.role === 'admin' &&
      request.auth.token.activeCompanyId === companyId;

    if (!isAdmin) continue;

    const companyAdminsSnap = await db
      .collectionGroup('memberships')
      .where('companyId', '==', companyId)
      .where('role', '==', 'admin')
      .get();

    if (companyAdminsSnap.size === 1 && companyAdminsSnap.docs[0].ref.path.startsWith(`users/${uid}/`)) {
      const companySnap = await db.doc(`companies/${companyId}`).get();
      const companyName = (companySnap.data()?.name as string | undefined) ?? companyId;
      throw new HttpsError(
        'failed-precondition',
        `You are the only admin of "${companyName}". Transfer the admin role or delete the company before deleting your account.`,
      );
    }
  }

  // ── 3. Anonymize user data across all companies ────────────────────────────
  let batch = db.batch();
  let opCount = 0;

  async function addOp(ref: FirebaseFirestore.DocumentReference, data: Record<string, null>) {
    batch.update(ref, data);
    opCount++;
    if (opCount >= BATCH_LIMIT) {
      batch = await commitAndReset(batch, db);
      opCount = 0;
    }
  }

  for (const companyId of companyIds) {
    const bookingsRef = db.collection(`companies/${companyId}/bookings`);
    const equipmentRef = db.collection(`companies/${companyId}/equipment`);

    // Bookings: userId
    const byUserId = await bookingsRef.where('userId', '==', uid).get();
    for (const doc of byUserId.docs) await addOp(doc.ref, { userId: null });

    // Bookings: cancelledBy
    const byCancelledBy = await bookingsRef.where('cancelledBy', '==', uid).get();
    for (const doc of byCancelledBy.docs) await addOp(doc.ref, { cancelledBy: null });

    // Bookings: approverId
    const byApproverId = await bookingsRef.where('approverId', '==', uid).get();
    for (const doc of byApproverId.docs) await addOp(doc.ref, { approverId: null });

    // Equipment: createdBy
    const byCreatedBy = await equipmentRef.where('createdBy', '==', uid).get();
    for (const doc of byCreatedBy.docs) await addOp(doc.ref, { createdBy: null });

    // Equipment: approverId
    const byEquipmentApprover = await equipmentRef.where('approverId', '==', uid).get();
    for (const doc of byEquipmentApprover.docs) await addOp(doc.ref, { approverId: null });

    // Units: read all units in company, filter in-code for user references
    const unitsSnap = await db
      .collectionGroup('units')
      .where('companyId', '==', companyId)
      .get();

    for (const doc of unitsSnap.docs) {
      const data = doc.data();
      const updates: Record<string, null> = {};
      if (data.createdBy === uid) updates.createdBy = null;
      if (data.updatedBy === uid) updates.updatedBy = null;
      if (data.deactivatedBy === uid) updates.deactivatedBy = null;
      if (Object.keys(updates).length > 0) await addOp(doc.ref, updates);
    }

    // Company doc: createdBy
    const companySnap = await db.doc(`companies/${companyId}`).get();
    if (companySnap.exists && companySnap.data()?.createdBy === uid) {
      await addOp(companySnap.ref, { createdBy: null });
    }
  }

  // ── 4. Delete user documents ───────────────────────────────────────────────
  for (const membershipDoc of membershipsSnap.docs) {
    batch.delete(membershipDoc.ref);
    opCount++;
    if (opCount >= BATCH_LIMIT) {
      batch = await commitAndReset(batch, db);
      opCount = 0;
    }
  }
  batch.delete(db.doc(`users/${uid}`));
  opCount++;

  // ── 5. Write deletion audit log (no PII) ──────────────────────────────────
  const userIdHash = createHash('sha256').update(uid).digest('hex');
  batch.set(db.collection('deletionAuditLog').doc(), {
    userIdHash,
    deletedAt: FieldValue.serverTimestamp(),
    triggeredBy: 'user_self',
  });

  await batch.commit();

  // ── 6. Delete Firebase Auth record (irreversible — must be last) ───────────
  await getAuth().deleteUser(uid);

  logger.info('deleteAccount: account deleted', { userIdHash });

  return { success: true };
});
