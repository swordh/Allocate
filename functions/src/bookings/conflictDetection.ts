/**
 * Shared conflict detection logic used by checkBookingConflict (read-only),
 * createBooking (inside transaction), updateBooking (inside transaction),
 * and approveBooking (inside transaction).
 *
 * Strategy (per ADR-007, Section 2):
 *   - Query bookings by equipmentIds array-contains + endDate range.
 *   - Filter in memory: booking.startDate <= requestedEndDate, status !== 'cancelled'.
 *   - For individual items: any overlap is a full conflict.
 *   - For quantity items: sum booked quantities; conflict if requested > available.
 *
 * The composite index required:
 *   equipmentIds (CONTAINS) + endDate (ASC)
 */

import { Firestore, Transaction } from 'firebase-admin/firestore';

export interface BookingItemInput {
  equipmentId: string;
  quantity: number;
}

export interface EquipmentData {
  trackingType: 'units' | 'quantity';
  totalQuantity: number;
  name: string;
  active: boolean;
}

export interface ConflictDetail {
  equipmentId: string;
  equipmentName: string;
  reason: 'already_booked' | 'insufficient_quantity';
  requested?: number;
  available?: number;
  conflictingBookingId?: string;
}

export interface ConflictResult {
  hasConflict: boolean;
  conflicts: ConflictDetail[];
}

/**
 * Booking document fields that conflict detection reads from Firestore.
 * Only the fields we actually need — keeps the type narrow.
 */
interface StoredBookingForConflict {
  startDate: string;
  endDate: string;
  startTime?: string | null;
  endTime?: string | null;
  status: string;
  approvalStatus: string;
  items: BookingItemInput[];
  equipmentIds: string[];
}

/**
 * Returns false only when both bookings are same-day with explicit time windows
 * that do not overlap. In all other cases returns true (conservative).
 */
function timesOverlap(
  a: { startDate: string; endDate: string; startTime?: string | null; endTime?: string | null },
  b: { startDate: string; endDate: string; startTime?: string | null; endTime?: string | null },
): boolean {
  // Time-based exclusion only applies to same-day bookings with explicit times
  if (a.startDate !== a.endDate || b.startDate !== b.endDate) return true;
  if (a.startDate !== b.startDate) return true;
  if (!a.startTime || !a.endTime || !b.startTime || !b.endTime) return true;
  return a.startTime < b.endTime && b.startTime < a.endTime;
}

/**
 * Run conflict detection outside of a transaction (used by checkBookingConflict).
 * This is advisory only — not authoritative. Write paths must use
 * detectConflictsInTransaction to prevent TOCTOU races.
 * Returns a ConflictResult describing all conflicts found.
 */
export async function detectConflictsReadOnly(
  db: Firestore,
  companyId: string,
  requestedItems: BookingItemInput[],
  startDate: string,
  endDate: string,
  excludeBookingId?: string,
  startTime?: string | null,
  endTime?: string | null,
): Promise<ConflictResult> {
  const conflicts: ConflictDetail[] = [];
  const bookingsRef = db.collection(`companies/${companyId}/bookings`);

  for (const item of requestedItems) {
    // Fetch the equipment document to get trackingType, totalQuantity, and name.
    const equipmentSnap = await db
      .doc(`companies/${companyId}/equipment/${item.equipmentId}`)
      .get();

    if (!equipmentSnap.exists) {
      // Treat missing equipment as a conflict — the caller should have validated this,
      // but be defensive here.
      conflicts.push({
        equipmentId: item.equipmentId,
        equipmentName: 'Unknown',
        reason: 'already_booked',
      });
      continue;
    }

    const equipment = equipmentSnap.data() as EquipmentData;

    // Query: all bookings that reference this equipment and whose end date is on or
    // after our requested start date. The startDate <= endDate half is checked in memory.
    const query = await bookingsRef
      .where('equipmentIds', 'array-contains', item.equipmentId)
      .where('endDate', '>=', startDate)
      .get();

    const requested = { startDate, endDate, startTime, endTime };
    const overlapping = query.docs.filter((doc) => {
      if (doc.id === excludeBookingId) return false;
      const data = doc.data() as StoredBookingForConflict;
      // Cancelled and rejected bookings do not hold equipment — exclude them.
      if (data.status === 'cancelled') return false;
      if (data.approvalStatus === 'rejected') return false;
      // The query gives us bookings whose endDate >= requestedStartDate.
      // We also need: booking.startDate <= requestedEndDate.
      if (data.startDate > endDate) return false;
      return timesOverlap(requested, data);
    });

    if (equipment.trackingType === 'units') {
      if (overlapping.length > 0) {
        conflicts.push({
          equipmentId: item.equipmentId,
          equipmentName: equipment.name,
          reason: 'already_booked',
          conflictingBookingId: overlapping[0].id,
        });
      }
    } else {
      // Quantity item: sum booked quantities across overlapping bookings.
      let sumBooked = 0;
      for (const doc of overlapping) {
        const data = doc.data() as StoredBookingForConflict;
        const matchingItem = data.items.find((i) => i.equipmentId === item.equipmentId);
        if (matchingItem) {
          sumBooked += matchingItem.quantity;
        }
      }
      const available = equipment.totalQuantity - sumBooked;
      if (item.quantity > available) {
        conflicts.push({
          equipmentId: item.equipmentId,
          equipmentName: equipment.name,
          reason: 'insufficient_quantity',
          requested: item.quantity,
          available: Math.max(0, available),
          conflictingBookingId: overlapping.length > 0 ? overlapping[0].id : undefined,
        });
      }
    }
  }

  return { hasConflict: conflicts.length > 0, conflicts };
}

/**
 * Run conflict detection inside a Firestore transaction.
 * Used by createBooking, updateBooking, and approveBooking to prevent
 * TOCTOU races — the reads are part of the same transaction snapshot.
 */
export async function detectConflictsInTransaction(
  tx: Transaction,
  db: Firestore,
  companyId: string,
  requestedItems: BookingItemInput[],
  startDate: string,
  endDate: string,
  excludeBookingId?: string,
  startTime?: string | null,
  endTime?: string | null,
): Promise<ConflictResult> {
  const conflicts: ConflictDetail[] = [];
  const bookingsRef = db.collection(`companies/${companyId}/bookings`);

  for (const item of requestedItems) {
    const equipmentRef = db.doc(`companies/${companyId}/equipment/${item.equipmentId}`);
    const equipmentSnap = await tx.get(equipmentRef);

    if (!equipmentSnap.exists) {
      conflicts.push({
        equipmentId: item.equipmentId,
        equipmentName: 'Unknown',
        reason: 'already_booked',
      });
      continue;
    }

    const equipment = equipmentSnap.data() as EquipmentData;

    // Firestore transactions support collection queries via tx.get(query).
    const query = bookingsRef
      .where('equipmentIds', 'array-contains', item.equipmentId)
      .where('endDate', '>=', startDate);

    const querySnap = await tx.get(query);

    const requested = { startDate, endDate, startTime, endTime };
    const overlapping = querySnap.docs.filter((doc) => {
      if (doc.id === excludeBookingId) return false;
      const data = doc.data() as StoredBookingForConflict;
      // Cancelled and rejected bookings do not hold equipment — exclude them.
      if (data.status === 'cancelled') return false;
      if (data.approvalStatus === 'rejected') return false;
      if (data.startDate > endDate) return false;
      return timesOverlap(requested, data);
    });

    if (equipment.trackingType === 'units') {
      if (overlapping.length > 0) {
        conflicts.push({
          equipmentId: item.equipmentId,
          equipmentName: equipment.name,
          reason: 'already_booked',
          conflictingBookingId: overlapping[0].id,
        });
      }
    } else {
      let sumBooked = 0;
      for (const doc of overlapping) {
        const data = doc.data() as StoredBookingForConflict;
        const matchingItem = data.items.find((i) => i.equipmentId === item.equipmentId);
        if (matchingItem) {
          sumBooked += matchingItem.quantity;
        }
      }
      const available = equipment.totalQuantity - sumBooked;
      if (item.quantity > available) {
        conflicts.push({
          equipmentId: item.equipmentId,
          equipmentName: equipment.name,
          reason: 'insufficient_quantity',
          requested: item.quantity,
          available: Math.max(0, available),
          conflictingBookingId: overlapping.length > 0 ? overlapping[0].id : undefined,
        });
      }
    }
  }

  return { hasConflict: conflicts.length > 0, conflicts };
}

/**
 * Validate the items array from caller input.
 * Returns a typed array or throws an HttpsError-compatible error object.
 * Callers are responsible for throwing the HttpsError.
 */
export function validateItems(rawItems: unknown): BookingItemInput[] {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw Object.assign(new Error('items must be a non-empty array.'), { code: 'invalid-argument' });
  }
  if (rawItems.length > 50) {
    throw Object.assign(new Error('items may not exceed 50 entries.'), { code: 'invalid-argument' });
  }
  return rawItems.map((entry: unknown, idx: number) => {
    if (typeof entry !== 'object' || entry === null) {
      throw Object.assign(
        new Error(`items[${idx}]: each entry must be an object.`),
        { code: 'invalid-argument' },
      );
    }
    const { equipmentId, quantity } = entry as Record<string, unknown>;
    if (typeof equipmentId !== 'string' || equipmentId.trim().length === 0) {
      throw Object.assign(
        new Error(`items[${idx}].equipmentId is required.`),
        { code: 'invalid-argument' },
      );
    }
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
      throw Object.assign(
        new Error(`items[${idx}].quantity must be a positive integer.`),
        { code: 'invalid-argument' },
      );
    }
    return { equipmentId: equipmentId.trim(), quantity };
  });
}

/**
 * Validate an ISO date string (YYYY-MM-DD).
 * Throws an HttpsError-compatible error for invalid input.
 */
export function validateDateString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw Object.assign(
      new Error(`${fieldName} must be a date string in YYYY-MM-DD format.`),
      { code: 'invalid-argument' },
    );
  }
  return value;
}

/**
 * Extract a flat array of equipment IDs from an items array.
 * Used to maintain the denormalized equipmentIds field.
 */
export function extractEquipmentIds(items: BookingItemInput[]): string[] {
  return items.map((i) => i.equipmentId);
}
