import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { BookingDocument } from '../types';

/**
 * Soft-cancels a booking. The document is retained for historical records.
 * Cancelled bookings are excluded from conflict detection queries.
 *
 * Only bookings with status 'pending' or 'confirmed' can be cancelled.
 * Checked-out bookings cannot be cancelled — equipment is physically out
 * and must be returned first.
 *
 * Booking owner or admin may cancel.
 *
 * @param data.companyId  - Company owning the booking
 * @param data.bookingId  - ID of the booking to cancel
 * @returns { success: true }
 * @throws unauthenticated     if caller is not signed in
 * @throws permission-denied   if companyId mismatch or caller is not the owner / admin
 * @throws invalid-argument    if companyId or bookingId are missing
 * @throws not-found           if the booking does not exist
 * @throws failed-precondition if the booking is already cancelled, returned, or checked out
 */
export const cancelBooking = onCall(async (request) => {
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

    // ── Ownership / role check ───────────────────────────────────────────────
    if (!isAdmin && booking.userId !== uid) {
      throw new HttpsError('permission-denied', 'You can only cancel your own bookings.');
    }

    // ── Status check ─────────────────────────────────────────────────────────
    if (booking.status === 'cancelled') {
      throw new HttpsError('failed-precondition', 'Booking is already cancelled.');
    }
    if (booking.status === 'returned') {
      throw new HttpsError('failed-precondition', 'Cannot cancel a returned booking.');
    }
    if (booking.status === 'checked_out') {
      throw new HttpsError(
        'failed-precondition',
        'Cannot cancel a checked-out booking. Return the equipment first.',
      );
    }

    tx.update(bookingRef, {
      status: 'cancelled',
      cancelledAt: FieldValue.serverTimestamp(),
      cancelledBy: uid,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  logger.info('cancelBooking: booking cancelled', {
    companyId,
    bookingId,
    uid,
  });

  return { success: true };
});
