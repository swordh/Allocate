import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { detectConflictsInTransaction } from './conflictDetection';
import { BookingDocument } from '../types';

/**
 * Approves a pending booking. Re-checks conflicts before confirming because
 * another booking may have claimed the same equipment between creation and approval.
 *
 * Caller must be the designated approverId on the booking, or have admin role.
 *
 * @param data.companyId  - Company owning the booking
 * @param data.bookingId  - ID of the booking to approve
 * @returns { success: true }
 * @throws unauthenticated     if caller is not signed in
 * @throws permission-denied   if companyId mismatch or caller is not the approverId / admin
 * @throws invalid-argument    if companyId or bookingId are missing
 * @throws not-found           if the booking does not exist
 * @throws failed-precondition if the booking is not in the pending/pending-approval state,
 *                             or if a conflict is detected at approval time
 */
export const approveBooking = onCall({ cors: true, invoker: 'public' }, async (request) => {
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

  // ── bookingId validation ───────────────────────────────────────────────────
  const rawBookingId: unknown = request.data.bookingId;
  if (typeof rawBookingId !== 'string' || rawBookingId.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'bookingId is required.');
  }
  const bookingId = rawBookingId.trim();

  const uid = request.auth.uid;
  const isAdmin = request.auth.token.role === 'admin';
  const db = getFirestore();

  await db.runTransaction(async (tx) => {
    const bookingRef = db.doc(`companies/${companyId}/bookings/${bookingId}`);
    const bookingSnap = await tx.get(bookingRef);

    if (!bookingSnap.exists) {
      throw new HttpsError('not-found', 'Booking not found.');
    }

    const booking = bookingSnap.data() as BookingDocument;

    // ── State check ──────────────────────────────────────────────────────────
    if (booking.status !== 'pending' || booking.approvalStatus !== 'pending') {
      throw new HttpsError(
        'failed-precondition',
        'Booking is not awaiting approval.',
      );
    }

    // ── Approver check ───────────────────────────────────────────────────────
    // Caller must be either the designated approverId or an admin.
    const isDesignatedApprover =
      booking.approverId !== null && booking.approverId === uid;

    if (!isAdmin && !isDesignatedApprover) {
      throw new HttpsError(
        'permission-denied',
        'Only the designated approver or an admin can approve this booking.',
      );
    }

    // ── Re-run conflict detection ─────────────────────────────────────────────
    // Availability may have changed since the booking was originally created.
    const conflictResult = await detectConflictsInTransaction(
      tx,
      db,
      companyId,
      booking.items,
      booking.startDate,
      booking.endDate,
      bookingId,
    );

    if (conflictResult.hasConflict) {
      const names = conflictResult.conflicts
        .map((c) => c.equipmentName)
        .join(', ');
      throw new HttpsError(
        'failed-precondition',
        `Cannot approve: conflict detected for ${names}. Resolve conflicts before approving.`,
      );
    }

    tx.update(bookingRef, {
      status: 'confirmed',
      approvalStatus: 'approved',
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  logger.info('approveBooking: booking approved', {
    companyId,
    bookingId,
    uid,
  });

  return { success: true };
});
