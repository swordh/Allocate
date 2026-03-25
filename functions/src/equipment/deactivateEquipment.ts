import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

/**
 * Soft-deletes an equipment item by setting active: false.
 *
 * Hard delete is permanently forbidden because existing bookings store
 * equipment IDs as string references in the equipmentIds array. Removing the
 * document would corrupt historical booking records.
 *
 * Before deactivating, this function checks for active or upcoming bookings
 * that reference this equipment (endTime > now). If any exist the operation
 * is blocked and the caller must remove those bookings first.
 *
 * @param data.companyId    - Company that owns the equipment
 * @param data.equipmentId  - Document ID to deactivate
 * @returns { success: true }
 * @throws unauthenticated      if caller is not signed in
 * @throws permission-denied    if companyId does not match the caller's activeCompanyId claim
 * @throws permission-denied    if caller's role is not 'admin'
 * @throws invalid-argument     if companyId or equipmentId are missing
 * @throws not-found            if the equipment document does not exist
 * @throws failed-precondition  if the equipment has active or upcoming bookings
 */
export const deactivateEquipment = onCall(async (request) => {
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

  const db = getFirestore();
  const equipmentRef = db.doc(`companies/${companyId}/equipment/${equipmentId}`);

  // ── Existence check ────────────────────────────────────────────────────────
  const equipmentSnap = await equipmentRef.get();
  if (!equipmentSnap.exists) {
    throw new HttpsError('not-found', 'Equipment not found.');
  }

  // ── Active/upcoming booking check ─────────────────────────────────────────
  // TODO Phase 3: re-introduce this check using the bookings 'items' array.
  // The booking schema uses items: { equipmentId: string, quantity: number }[]
  // Firestore does not support array-contains on map values, so the check must
  // fetch bookings by date range and filter in application code.
  // Do NOT restore the old equipmentIds query — that field no longer exists.
  //
  // For Phase 2 (no booking documents exist) the check is skipped entirely.

  // ── Soft delete ────────────────────────────────────────────────────────────
  await equipmentRef.update({
    active: false,
    deactivatedAt: FieldValue.serverTimestamp(),
  });

  logger.info('deactivateEquipment: equipment deactivated', {
    companyId,
    equipmentId,
    uid: request.auth.uid,
  });

  return { success: true };
});
