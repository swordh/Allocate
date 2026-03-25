import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

/**
 * Updates fields on an existing equipment document.
 * Only fields explicitly provided in the request are written — undefined
 * fields are never set so callers can perform partial updates.
 *
 * @param data.companyId         - Company that owns the equipment
 * @param data.equipmentId       - Document ID to update
 * @param data.name              - Optional new display name (max 100 chars)
 * @param data.category          - Optional new category label
 * @param data.status            - Optional new status
 * @param data.requiresApproval  - Optional approval flag override
 * @param data.approverId        - Optional approver userId or null
 * @returns { success: true }
 * @throws unauthenticated     if caller is not signed in
 * @throws permission-denied   if companyId does not match the caller's activeCompanyId claim
 * @throws permission-denied   if caller's role is not 'admin'
 * @throws invalid-argument    if companyId or equipmentId are missing
 * @throws invalid-argument    if name exceeds 100 chars when provided
 * @throws invalid-argument    if status is not one of the accepted values when provided
 * @throws not-found           if the equipment document does not exist
 */
export const updateEquipment = onCall(async (request) => {
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

  // ── Optional field validation ──────────────────────────────────────────────
  const VALID_STATUSES = ['available', 'checked_out', 'needs_repair'] as const;
  type EquipmentStatus = typeof VALID_STATUSES[number];

  // Build the update payload — only include keys that were explicitly supplied.
  // Writing undefined to Firestore would corrupt the document.
  const updates: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (request.data.name !== undefined) {
    const rawName: unknown = request.data.name;
    if (typeof rawName !== 'string' || rawName.trim().length === 0) {
      throw new HttpsError('invalid-argument', 'name must be a non-empty string.');
    }
    if (rawName.trim().length > 100) {
      throw new HttpsError('invalid-argument', 'name must be 100 characters or fewer.');
    }
    updates['name'] = rawName.trim();
  }

  if (request.data.category !== undefined) {
    const rawCategory: unknown = request.data.category;
    if (typeof rawCategory !== 'string' || rawCategory.trim().length === 0) {
      throw new HttpsError('invalid-argument', 'category must be a non-empty string.');
    }
    updates['category'] = rawCategory.trim();
  }

  if (request.data.status !== undefined) {
    const rawStatus: unknown = request.data.status;
    if (!VALID_STATUSES.includes(rawStatus as EquipmentStatus)) {
      throw new HttpsError(
        'invalid-argument',
        `status must be one of: ${VALID_STATUSES.join(', ')}.`,
      );
    }
    updates['status'] = rawStatus as EquipmentStatus;
  }

  if (request.data.requiresApproval !== undefined) {
    updates['requiresApproval'] = Boolean(request.data.requiresApproval);
  }

  if (request.data.approverId !== undefined) {
    updates['approverId'] =
      request.data.approverId === null ? null : String(request.data.approverId);
  }

  // ── Existence check + write ────────────────────────────────────────────────
  const db = getFirestore();
  const equipmentRef = db.doc(`companies/${companyId}/equipment/${equipmentId}`);
  const equipmentSnap = await equipmentRef.get();

  if (!equipmentSnap.exists) {
    throw new HttpsError('not-found', 'Equipment not found.');
  }

  await equipmentRef.update(updates);

  logger.info('updateEquipment: equipment updated', {
    companyId,
    equipmentId,
    uid: request.auth.uid,
    fields: Object.keys(updates).filter((k) => k !== 'updatedAt'),
  });

  return { success: true };
});
