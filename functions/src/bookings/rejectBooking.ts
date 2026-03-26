import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { BookingDocument } from '../types';

/**
 * Rejects a pending booking. The booking remains in 'pending' status with
 * approvalStatus 'rejected'. This is intentionally not a terminal state —
 * the booking owner may edit the booking and resubmit (handled by updateBooking).
 *
 * Caller must be the designated approverId on the booking, or have admin role.
 *
 * @param data.companyId  - Company owning the booking
 * @param data.bookingId  - ID of the booking to reject
 * @param data.reason     - Optional rejection reason, max 500 chars
 * @returns { success: true }
 * @throws unauthenticated     if caller is not signed in
 * @throws permission-denied   if companyId mismatch or caller is not the approverId / admin
 * @throws invalid-argument    if companyId or bookingId are missing
 * @throws not-found           if the booking does not exist
 * @throws failed-precondition if the booking is not in the pending/pending-approval state
 */
export const rejectBooking = onCall({ region: 'europe-west1', cors: true, invoker: 'public' }, async (request) => {
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

  // ── Optional reason ────────────────────────────────────────────────────────
  const rawReason: unknown = request.data.reason;
  let rejectionReason: string | null = null;
  if (rawReason !== undefined && rawReason !== null) {
    if (typeof rawReason !== 'string') {
      throw new HttpsError('invalid-argument', 'reason must be a string.');
    }
    if (rawReason.length > 500) {
      throw new HttpsError('invalid-argument', 'reason must be 500 characters or fewer.');
    }
    rejectionReason = rawReason.trim() || null;
  }

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
    const isDesignatedApprover =
      booking.approverId !== null && booking.approverId === uid;

    if (!isAdmin && !isDesignatedApprover) {
      throw new HttpsError(
        'permission-denied',
        'Only the designated approver or an admin can reject this booking.',
      );
    }

    // status stays 'pending'; only approvalStatus changes.
    tx.update(bookingRef, {
      approvalStatus: 'rejected',
      rejectionReason,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  logger.info('rejectBooking: booking rejected', {
    companyId,
    bookingId,
    uid,
  });

  return { success: true };
});
