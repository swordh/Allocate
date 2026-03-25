import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { BookingDocument, BookingStatus } from '../types';

/**
 * Handles operational status transitions:
 *   confirmed  -> checked_out   (equipment picked up)
 *   checked_out -> returned     (equipment returned)
 *
 * Does NOT handle approval (use approveBooking), rejection (use rejectBooking),
 * or cancellation (use cancelBooking).
 *
 * Admin can update any booking. Crew can only update their own.
 *
 * @param data.companyId  - Company owning the booking
 * @param data.bookingId  - ID of the booking to update
 * @param data.newStatus  - Target status: 'checked_out' or 'returned'
 * @returns { success: true }
 * @throws unauthenticated     if caller is not signed in
 * @throws permission-denied   if companyId mismatch, caller is a viewer, or
 *                             crew is not the booking owner
 * @throws invalid-argument    if companyId, bookingId, or newStatus are invalid
 * @throws not-found           if the booking does not exist
 * @throws failed-precondition if the requested transition is not allowed from current status
 */
export const updateBookingStatus = onCall(async (request) => {
  // ── Auth guard ─────────────────────────────────────────────────────────────
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in.');
  }

  // ── Role check — viewers cannot update status ──────────────────────────────
  const role = request.auth.token.role as string;
  if (role !== 'admin' && role !== 'crew') {
    throw new HttpsError('permission-denied', 'Crew or admin access required.');
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

  // ── newStatus validation ───────────────────────────────────────────────────
  const ALLOWED_TARGET_STATUSES: BookingStatus[] = ['checked_out', 'returned'];
  const rawNewStatus: unknown = request.data.newStatus;
  if (!ALLOWED_TARGET_STATUSES.includes(rawNewStatus as BookingStatus)) {
    throw new HttpsError(
      'invalid-argument',
      `newStatus must be one of: ${ALLOWED_TARGET_STATUSES.join(', ')}.`,
    );
  }
  const newStatus = rawNewStatus as BookingStatus;

  const uid = request.auth.uid;
  const isAdmin = role === 'admin';
  const db = getFirestore();

  await db.runTransaction(async (tx) => {
    const bookingRef = db.doc(`companies/${companyId}/bookings/${bookingId}`);
    const bookingSnap = await tx.get(bookingRef);

    if (!bookingSnap.exists) {
      throw new HttpsError('not-found', 'Booking not found.');
    }

    const booking = bookingSnap.data() as BookingDocument;

    // ── Ownership check for crew ─────────────────────────────────────────────
    if (!isAdmin && booking.userId !== uid) {
      throw new HttpsError(
        'permission-denied',
        'You can only update status on your own bookings.',
      );
    }

    // ── State machine validation ─────────────────────────────────────────────
    const ALLOWED_TRANSITIONS: Partial<Record<BookingStatus, BookingStatus>> = {
      confirmed: 'checked_out',
      checked_out: 'returned',
    };

    const allowedNext = ALLOWED_TRANSITIONS[booking.status];
    if (allowedNext !== newStatus) {
      throw new HttpsError(
        'failed-precondition',
        `Cannot transition from '${booking.status}' to '${newStatus}'.`,
      );
    }

    tx.update(bookingRef, {
      status: newStatus,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  logger.info('updateBookingStatus: status updated', {
    companyId,
    bookingId,
    newStatus,
    uid,
  });

  return { success: true };
});
