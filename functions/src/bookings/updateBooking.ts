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
import { BookingDocument, EquipmentDocument } from '../types';

/**
 * Updates a booking's mutable fields. Re-runs conflict detection if dates
 * or items change. Resets approvalStatus to 'pending' if a rejected booking
 * is edited and resubmitted.
 *
 * Only allowed on bookings with status 'pending' or 'confirmed'.
 * Booking owner (userId == caller) or admin may update.
 *
 * @param data.companyId    - Company owning the booking
 * @param data.bookingId    - ID of the booking to update
 * @param data.projectName  - Optional, 1-200 chars
 * @param data.startDate    - Optional, "YYYY-MM-DD"
 * @param data.endDate      - Optional, "YYYY-MM-DD"
 * @param data.items        - Optional, same validation as create
 * @param data.notes        - Optional, max 2000 chars
 * @returns { success: true }
 * @throws unauthenticated     if caller is not signed in
 * @throws permission-denied   if companyId mismatch, or caller is crew and not the owner
 * @throws invalid-argument    if any provided field is invalid
 * @throws not-found           if booking or any new equipment does not exist
 * @throws failed-precondition if booking status does not allow edits, or conflict detected
 */
export const updateBooking = onCall({ region: 'europe-west1', cors: true, invoker: 'public' }, async (request) => {
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

  // ── Optional field validation ──────────────────────────────────────────────
  const rawProjectName: unknown = request.data.projectName;
  let projectName: string | undefined;
  if (rawProjectName !== undefined && rawProjectName !== null) {
    if (typeof rawProjectName !== 'string' || rawProjectName.trim().length === 0) {
      throw new HttpsError('invalid-argument', 'projectName must be a non-empty string.');
    }
    if (rawProjectName.trim().length > 200) {
      throw new HttpsError('invalid-argument', 'projectName must be 200 characters or fewer.');
    }
    projectName = rawProjectName.trim();
  }

  let items: BookingItemInput[] | undefined;
  if (request.data.items !== undefined && request.data.items !== null) {
    try {
      items = validateItems(request.data.items);
    } catch (err: unknown) {
      throw new HttpsError('invalid-argument', (err as Error).message);
    }
  }

  let startDate: string | undefined;
  let endDate: string | undefined;
  if (request.data.startDate !== undefined && request.data.startDate !== null) {
    try {
      startDate = validateDateString(request.data.startDate, 'startDate');
    } catch (err: unknown) {
      throw new HttpsError('invalid-argument', (err as Error).message);
    }
  }
  if (request.data.endDate !== undefined && request.data.endDate !== null) {
    try {
      endDate = validateDateString(request.data.endDate, 'endDate');
    } catch (err: unknown) {
      throw new HttpsError('invalid-argument', (err as Error).message);
    }
  }

  const rawNotes: unknown = request.data.notes;
  let notes: string | undefined;
  if (rawNotes !== undefined && rawNotes !== null) {
    if (typeof rawNotes !== 'string') {
      throw new HttpsError('invalid-argument', 'notes must be a string.');
    }
    if (rawNotes.length > 2000) {
      throw new HttpsError('invalid-argument', 'notes must be 2000 characters or fewer.');
    }
    notes = rawNotes;
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

    // ── Ownership / role check ───────────────────────────────────────────────
    if (!isAdmin && booking.userId !== uid) {
      throw new HttpsError('permission-denied', 'You can only edit your own bookings.');
    }

    // ── Status check ─────────────────────────────────────────────────────────
    if (booking.status !== 'pending' && booking.status !== 'confirmed') {
      throw new HttpsError(
        'failed-precondition',
        `Cannot edit a booking with status '${booking.status}'.`,
      );
    }

    // Determine effective values after merge.
    const effectiveItems = items ?? booking.items;
    const effectiveStartDate = startDate ?? booking.startDate;
    const effectiveEndDate = endDate ?? booking.endDate;

    // Cross-validate final date pair.
    if (effectiveEndDate < effectiveStartDate) {
      throw new HttpsError('invalid-argument', 'endDate must be on or after startDate.');
    }

    // ── Re-validate equipment if items changed ─────────────────────────────
    let requiresApproval = booking.requiresApproval;
    let approverId = booking.approverId;

    if (items !== undefined) {
      requiresApproval = false;
      approverId = null;

      for (const item of items) {
        const equipRef = db.doc(`companies/${companyId}/equipment/${item.equipmentId}`);
        const equipSnap = await tx.get(equipRef);

        if (!equipSnap.exists) {
          throw new HttpsError('not-found', `Equipment ${item.equipmentId} not found.`);
        }

        const equipment = equipSnap.data() as EquipmentDocument;

        if (!equipment.active) {
          throw new HttpsError(
            'failed-precondition',
            `Equipment "${equipment.name}" is not available (deactivated).`,
          );
        }

        if (equipment.trackingType === 'individual' && item.quantity !== 1) {
          throw new HttpsError(
            'invalid-argument',
            `Equipment "${equipment.name}" is individually tracked; quantity must be 1.`,
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
          if (approverId === null && equipment.approverId) {
            approverId = equipment.approverId;
          }
        }
      }
    }

    // ── Conflict detection if dates or items changed ───────────────────────
    const datesChanged = startDate !== undefined || endDate !== undefined;
    const itemsChanged = items !== undefined;

    if (datesChanged || itemsChanged) {
      const conflictResult = await detectConflictsInTransaction(
        tx,
        db,
        companyId,
        effectiveItems,
        effectiveStartDate,
        effectiveEndDate,
        bookingId, // exclude this booking from its own conflict check
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
    }

    // ── Build update payload ──────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: Record<string, any> = {
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (projectName !== undefined) updateData.projectName = projectName;
    if (notes !== undefined) updateData.notes = notes;
    if (startDate !== undefined) updateData.startDate = startDate;
    if (endDate !== undefined) updateData.endDate = endDate;
    if (items !== undefined) {
      updateData.items = items;
      updateData.equipmentIds = extractEquipmentIds(items);
      updateData.requiresApproval = requiresApproval;
      updateData.approverId = approverId;
    }

    // Re-apply approval logic when dates or items change on an approval-required booking.
    if (datesChanged || itemsChanged) {
      if (requiresApproval) {
        // Reset to pending regardless of previous approval state.
        // This covers: re-edits of rejected bookings AND edits of already-confirmed
        // bookings that require approval — the approver must re-evaluate the new dates/items.
        updateData.status = 'pending';
        updateData.approvalStatus = 'pending';
        updateData.rejectionReason = null;
      } else {
        // No approval required — ensure booking is confirmed after edit.
        updateData.status = 'confirmed';
        updateData.approvalStatus = 'none';
        updateData.rejectionReason = null;
      }
    }

    tx.update(bookingRef, updateData);
  });

  logger.info('updateBooking: booking updated', {
    companyId,
    bookingId,
    uid,
  });

  return { success: true };
});
