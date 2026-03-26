import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

/**
 * Soft-deletes an equipment item by setting active: false.
 *
 * Hard delete is permanently forbidden because existing bookings store
 * equipment IDs in the denormalized equipmentIds array. Removing the document
 * would corrupt historical booking records.
 *
 * Before deactivating, this function queries for active or upcoming bookings
 * that reference this equipment (endDate >= today, status in pending/confirmed/checked_out).
 * The array-contains + in filter combination is unsupported by Firestore, so we
 * filter by equipmentIds array-contains + endDate range and filter status in memory.
 *
 * Composite index required: equipmentIds (CONTAINS) + endDate (ASC)
 * — see firestore.indexes.json
 *
 * @param data.companyId    - Company that owns the equipment
 * @param data.equipmentId  - Document ID to deactivate
 * @param data.force        - If true, deactivate even when active bookings exist.
 *                            If false (default), return requiresForce: true when
 *                            active bookings exist so the UI can prompt the admin.
 * @returns { success: true } on successful deactivation
 * @returns { requiresForce: true, affectedBookingCount: number } when active bookings
 *          exist and force is false
 * @throws unauthenticated      if caller is not signed in
 * @throws permission-denied    if companyId does not match the caller's activeCompanyId claim
 * @throws permission-denied    if caller's role is not 'admin'
 * @throws invalid-argument     if companyId or equipmentId are missing
 * @throws not-found            if the equipment document does not exist
 */
export const deactivateEquipment = onCall({ region: 'europe-west1', cors: true, invoker: 'public' }, async (request) => {
  // ── Auth guard ─────────────────────────────────────────────────────────────
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in.');
  }

  // ── Company claim verification ─────────────────────────────────────────────
  const rawCompanyId: unknown = request.data.companyId;
  if (typeof rawCompanyId !== 'string' || rawCompanyId.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'companyId is required.');
  }
  const companyId = rawCompanyId.trim();

  if (request.auth.token.activeCompanyId !== companyId) {
    throw new HttpsError('permission-denied', 'Company mismatch.');
  }

  // ── Role check ─────────────────────────────────────────────────────────────
  if (request.auth.token.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admins only.');
  }

  // ── Equipment ID validation ────────────────────────────────────────────────
  const rawEquipmentId: unknown = request.data.equipmentId;
  if (typeof rawEquipmentId !== 'string' || rawEquipmentId.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'equipmentId is required.');
  }
  const equipmentId = rawEquipmentId.trim();

  // ── force param ────────────────────────────────────────────────────────────
  const force: boolean = Boolean(request.data.force) === true;

  const db = getFirestore();
  const equipmentRef = db.doc(`companies/${companyId}/equipment/${equipmentId}`);

  // ── Existence check ────────────────────────────────────────────────────────
  const equipmentSnap = await equipmentRef.get();
  if (!equipmentSnap.exists) {
    throw new HttpsError('not-found', 'Equipment not found.');
  }

  // ── Active/upcoming booking check ──────────────────────────────────────────
  // Query bookings that reference this equipment and have not ended yet.
  // Firestore does not support array-contains combined with 'in' in the same query,
  // so we query by equipmentIds array-contains + endDate range, then filter
  // by status in memory.
  const ACTIVE_STATUSES = new Set(['pending', 'confirmed', 'checked_out']);
  const todayStr = new Date().toISOString().slice(0, 10);

  const bookingsSnap = await db
    .collection(`companies/${companyId}/bookings`)
    .where('equipmentIds', 'array-contains', equipmentId)
    .where('endDate', '>=', todayStr)
    .get();

  const activeBookings = bookingsSnap.docs.filter((doc) => {
    const data = doc.data();
    return ACTIVE_STATUSES.has(data.status as string);
  });

  if (activeBookings.length > 0 && !force) {
    // Return warning data without deactivating. The UI will prompt the admin
    // to confirm with force: true.
    return {
      requiresForce: true,
      affectedBookingCount: activeBookings.length,
    };
  }

  // ── Soft delete ────────────────────────────────────────────────────────────
  await equipmentRef.update({
    active: false,
    deactivatedAt: FieldValue.serverTimestamp(),
  });

  logger.info('deactivateEquipment: equipment deactivated', {
    companyId,
    equipmentId,
    force,
    affectedBookingCount: activeBookings.length,
    uid: request.auth.uid,
  });

  return { success: true };
});
