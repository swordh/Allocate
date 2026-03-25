import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import {
  detectConflictsReadOnly,
  validateItems,
  validateDateString,
} from './conflictDetection';

/**
 * Read-only conflict pre-check callable by any authenticated company member.
 * Called from the booking form on date selection to give the user early feedback.
 * The authoritative conflict check runs again inside createBooking's transaction.
 *
 * @param data.companyId          - Company owning the bookings
 * @param data.startDate          - "YYYY-MM-DD"
 * @param data.endDate            - "YYYY-MM-DD"
 * @param data.items              - Array of { equipmentId, quantity }
 * @param data.excludeBookingId   - Optional booking ID to exclude (for edit flows)
 * @returns { hasConflict, conflicts[] }
 * @throws unauthenticated   if caller is not signed in
 * @throws permission-denied if companyId does not match the caller's activeCompanyId claim
 * @throws invalid-argument  if required fields are missing or malformed
 */
export const checkBookingConflict = onCall(async (request) => {
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
  let items;
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

  const rawExclude: unknown = request.data.excludeBookingId;
  const excludeBookingId: string | undefined =
    typeof rawExclude === 'string' && rawExclude.trim().length > 0
      ? rawExclude.trim()
      : undefined;

  // ── Conflict detection ─────────────────────────────────────────────────────
  const db = getFirestore();
  const result = await detectConflictsReadOnly(
    db,
    companyId,
    items,
    startDate,
    endDate,
    excludeBookingId,
  );

  return result;
});
