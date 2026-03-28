import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import {
  detectConflictsInTransaction,
  validateItems,
  validateDateString,
  extractEquipmentIds,
  BookingItemInput,
} from './conflictDetection';
import { CompanyDocument, EquipmentDocument } from '../types';

/**
 * Creates a new booking after running full conflict detection inside a transaction.
 *
 * Any authenticated company member (viewer, crew, or admin) may create bookings.
 *
 * @param data.companyId    - Company to create the booking in
 * @param data.projectName  - Required, 1-200 chars
 * @param data.startDate    - "YYYY-MM-DD", must be today or future
 * @param data.endDate      - "YYYY-MM-DD", must be >= startDate
 * @param data.items        - Array of { equipmentId, quantity }, max 50
 * @param data.notes        - Optional free text, max 2000 chars
 * @returns { bookingId: string, success: true }
 * @throws unauthenticated      if caller is not signed in
 * @throws permission-denied    if companyId does not match the caller's activeCompanyId claim
 * @throws invalid-argument     if any required field is missing or invalid
 * @throws not-found            if the company or any equipment document does not exist
 * @throws failed-precondition  if subscription is inactive, equipment is inactive,
 *                              or a conflict is detected
 */
export const createBooking = onCall({ region: 'europe-west1', cors: true, invoker: 'public' }, async (request) => {
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

  // ── Input validation ───────────────────────────────────────────────────────
  const rawProjectName: unknown = request.data.projectName;
  if (typeof rawProjectName !== 'string' || rawProjectName.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'projectName is required.');
  }
  if (rawProjectName.trim().length > 200) {
    throw new HttpsError('invalid-argument', 'projectName must be 200 characters or fewer.');
  }
  const projectName = rawProjectName.trim();

  let items: BookingItemInput[];
  try {
    items = validateItems(request.data.items);
  } catch (err: unknown) {
    throw new HttpsError('invalid-argument', (err as Error).message);
  }

  let startDate: string;
  let endDate: string;
  try {
    startDate = validateDateString(request.data.startDate, 'startDate');
    endDate = validateDateString(request.data.endDate, 'endDate');
  } catch (err: unknown) {
    throw new HttpsError('invalid-argument', (err as Error).message);
  }

  if (endDate < startDate) {
    throw new HttpsError('invalid-argument', 'endDate must be on or after startDate.');
  }

  // startDate must be today or in the future.
  const todayStr = new Date().toISOString().slice(0, 10);
  if (startDate < todayStr) {
    throw new HttpsError('invalid-argument', 'startDate must be today or a future date.');
  }

  const rawNotes: unknown = request.data.notes;
  let notes = '';
  if (rawNotes !== undefined && rawNotes !== null) {
    if (typeof rawNotes !== 'string') {
      throw new HttpsError('invalid-argument', 'notes must be a string.');
    }
    if (rawNotes.length > 2000) {
      throw new HttpsError('invalid-argument', 'notes must be 2000 characters or fewer.');
    }
    notes = rawNotes;
  }

  // ── Transaction ────────────────────────────────────────────────────────────
  const db = getFirestore();
  const uid = request.auth.uid;
  let newBookingId: string;

  await db.runTransaction(async (tx) => {
    // 1. Verify subscription status.
    const companyRef = db.doc(`companies/${companyId}`);
    const companySnap = await tx.get(companyRef);
    if (!companySnap.exists) {
      throw new HttpsError('not-found', 'Company not found.');
    }
    const company = companySnap.data() as CompanyDocument;
    const { status: subStatus } = company.subscription;
    if (subStatus !== 'active' && subStatus !== 'trialing') {
      throw new HttpsError(
        'failed-precondition',
        'Subscription is not active. Reactivate your plan to create bookings.',
      );
    }

    // 2. userName is intentionally not stored on booking documents.
    //    userId is the canonical reference; callers resolve the display name
    //    at read time from the user document. Storing a denormalized name
    //    on the booking constitutes unnecessary PII retention (GDPR Art. 5(1)(c))
    //    and would require anonymization on account deletion in addition to userId.
    //    Phase 5 data export: include userId + companyId so the export can
    //    reconstruct the human-readable name from the user profile at export time.

    // 3. Validate all equipment items inside the transaction.
    //    Collect requiresApproval flag and approverId from equipment documents.
    let requiresApproval = false;
    let approverId: string | null = null;

    for (const item of items) {
      const equipRef = db.doc(`companies/${companyId}/equipment/${item.equipmentId}`);
      const equipSnap = await tx.get(equipRef);

      if (!equipSnap.exists) {
        throw new HttpsError(
          'not-found',
          `Equipment ${item.equipmentId} not found.`,
        );
      }

      const equipment = equipSnap.data() as EquipmentDocument;

      if (!equipment.active) {
        throw new HttpsError(
          'failed-precondition',
          `Equipment "${equipment.name}" is not available (deactivated).`,
        );
      }

      if (equipment.trackingType === 'serialized' && item.quantity !== 1) {
        throw new HttpsError(
          'invalid-argument',
          `Equipment "${equipment.name}" is serialized; quantity must be 1.`,
        );
      }

      if (
        equipment.trackingType === 'quantity' &&
        item.quantity > equipment.totalQuantity
      ) {
        throw new HttpsError(
          'invalid-argument',
          `Requested quantity (${item.quantity}) exceeds total stock (${equipment.totalQuantity}) for "${equipment.name}".`,
        );
      }

      if (equipment.requiresApproval) {
        requiresApproval = true;
        // Use the first approver found; falls back to null (any admin).
        if (approverId === null && equipment.approverId) {
          approverId = equipment.approverId;
        }
      }
    }

    // 4. Conflict detection — runs inside the transaction to prevent TOCTOU races.
    const conflictResult = await detectConflictsInTransaction(
      tx,
      db,
      companyId,
      items,
      startDate,
      endDate,
    );

    if (conflictResult.hasConflict) {
      const names = conflictResult.conflicts
        .map((c) => c.equipmentName)
        .join(', ');
      throw new HttpsError(
        'failed-precondition',
        `Booking conflict detected for: ${names}.`,
      );
    }

    // 5. Write the booking document.
    const bookingsRef = db.collection(`companies/${companyId}/bookings`);
    const newRef = bookingsRef.doc();
    newBookingId = newRef.id;

    const bookingStatus = requiresApproval ? 'pending' : 'confirmed';
    const approvalStatus = requiresApproval ? 'pending' : 'none';
    const equipmentIds = extractEquipmentIds(items);

    tx.set(newRef, {
      projectName,
      notes,
      items,
      equipmentIds,
      startDate,
      endDate,
      userId: uid,
      userName: null,
      status: bookingStatus,
      requiresApproval,
      approverId,
      approvalStatus,
      rejectionReason: null,
      cancelledAt: null,
      cancelledBy: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: null,
    });
  });

  logger.info('createBooking: booking created', {
    companyId,
    bookingId: newBookingId!,
    uid: uid.slice(0, 8) + '...',
  });

  return { bookingId: newBookingId!, success: true };
});
