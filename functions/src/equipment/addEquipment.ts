import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { CompanyDocument } from '../types';
import { validateCustomFields } from './validateCustomFields';

/**
 * Adds a new equipment item to a company's inventory.
 * Enforces the plan equipment limit inside a transaction so there is no
 * race condition between counting and writing.
 *
 * @param data.companyId         - Company to add equipment to
 * @param data.name              - Display name (required, max 100 chars)
 * @param data.category          - Category label (required)
 * @param data.trackingType      - 'serialized' or 'quantity' (required, immutable after creation)
 * @param data.totalQuantity     - Pool size for quantity items; forced to 1 for individual items
 * @param data.serialNumber      - Optional serial number for individual items; rejected on quantity items
 * @param data.status            - Initial status; defaults to 'available'
 * @param data.requiresApproval  - Whether bookings need approval; defaults to false
 * @param data.approverId        - UserId of the designated approver, or null for any Admin
 * @returns { equipmentId: string, success: true }
 * @throws unauthenticated      if caller is not signed in
 * @throws permission-denied    if companyId does not match the caller's activeCompanyId claim
 * @throws permission-denied    if caller's role is not 'admin'
 * @throws invalid-argument     if name is missing or exceeds 100 chars
 * @throws invalid-argument     if category is missing
 * @throws not-found            if the company document does not exist
 * @throws failed-precondition  if subscription status is not 'trialing' or 'active'
 * @throws resource-exhausted   if the company is at its equipment limit
 */
export const addEquipment = onCall({ region: 'europe-west1', cors: true, invoker: 'public' }, async (request) => {
  // ── Auth guard ─────────────────────────────────────────────────────────────
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in.');
  }

  // ── Company claim verification ─────────────────────────────────────────────
  // Never trust a companyId supplied by the client. Validate it against the
  // activeCompanyId stored in the verified JWT claim.
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

  // ── Input validation ───────────────────────────────────────────────────────
  const rawName: unknown = request.data.name;
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'name is required.');
  }
  if (rawName.trim().length > 100) {
    throw new HttpsError('invalid-argument', 'name must be 100 characters or fewer.');
  }
  const name = rawName.trim();

  const rawCategory: unknown = request.data.category;
  if (typeof rawCategory !== 'string' || rawCategory.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'category is required.');
  }
  const category = rawCategory.trim();

  const VALID_STATUSES = ['available', 'checked_out', 'needs_repair'] as const;
  type EquipmentStatus = typeof VALID_STATUSES[number];

  const rawStatus: unknown = request.data.status;
  let status: EquipmentStatus = 'available';
  if (rawStatus !== undefined) {
    if (!VALID_STATUSES.includes(rawStatus as EquipmentStatus)) {
      throw new HttpsError(
        'invalid-argument',
        `status must be one of: ${VALID_STATUSES.join(', ')}.`,
      );
    }
    status = rawStatus as EquipmentStatus;
  }

  const rawRequiresApproval: unknown = request.data.requiresApproval;
  const requiresApproval: boolean =
    rawRequiresApproval === undefined ? false : Boolean(rawRequiresApproval);

  const rawApproverId: unknown = request.data.approverId;
  const approverId: string | null =
    rawApproverId === undefined || rawApproverId === null
      ? null
      : String(rawApproverId);

  const customFields = validateCustomFields(request.data.customFields);

  // ── trackingType validation ────────────────────────────────────────────────
  const VALID_TRACKING_TYPES = ['serialized', 'quantity'] as const;
  type TrackingType = typeof VALID_TRACKING_TYPES[number];

  const rawTrackingType: unknown = request.data.trackingType;
  if (!VALID_TRACKING_TYPES.includes(rawTrackingType as TrackingType)) {
    throw new HttpsError(
      'invalid-argument',
      `trackingType is required and must be one of: ${VALID_TRACKING_TYPES.join(', ')}.`,
    );
  }
  const trackingType = rawTrackingType as TrackingType;

  // ── totalQuantity validation ───────────────────────────────────────────────
  let totalQuantity = 1;
  if (trackingType === 'quantity') {
    const rawQty: unknown = request.data.totalQuantity;
    if (typeof rawQty !== 'number' || !Number.isInteger(rawQty) || rawQty < 1) {
      throw new HttpsError('invalid-argument', 'totalQuantity must be a positive integer for quantity items.');
    }
    totalQuantity = rawQty;
  }
  // For serialized items totalQuantity is always 1, regardless of what the client sends.

  // ── serialNumber validation ────────────────────────────────────────────────
  let serialNumber: string | null = null;
  if (trackingType === 'quantity' && request.data.serialNumber !== undefined && request.data.serialNumber !== null) {
    throw new HttpsError('invalid-argument', 'serialNumber is not allowed for quantity-tracked items.');
  }
  if (trackingType === 'serialized' && request.data.serialNumber) {
    serialNumber = String(request.data.serialNumber).trim() || null;
  }

  // ── Transaction: count + write atomically ──────────────────────────────────
  const db = getFirestore();
  let newEquipmentId: string;

  await db.runTransaction(async (tx) => {
    // Read company document inside transaction to get subscription state.
    const companyRef = db.doc(`companies/${companyId}`);
    const companySnap = await tx.get(companyRef);

    if (!companySnap.exists) {
      throw new HttpsError('not-found', 'Company not found.');
    }

    const company = companySnap.data() as CompanyDocument;
    const { subscription } = company;

    if (subscription.status !== 'trialing' && subscription.status !== 'active') {
      throw new HttpsError(
        'failed-precondition',
        'Subscription is not active. Reactivate your plan to add equipment.',
      );
    }

    // Count active equipment — called outside the transaction because Firestore
    // aggregation queries cannot run inside runTransaction. The plan limit is a
    // soft cap so the negligible TOCTOU window is acceptable.
    const equipmentRef = db.collection(`companies/${companyId}/equipment`);
    const countSnap = await equipmentRef.where('active', '==', true).count().get();
    const currentCount = countSnap.data().count;

    const limit = subscription.limits.equipment;
    const plan = subscription.plan;

    if (currentCount >= limit) {
      throw new HttpsError(
        'resource-exhausted',
        `Equipment limit reached. Your ${plan} plan allows ${limit} items. Upgrade to add more.`,
      );
    }

    // All checks passed — create the document inside the transaction.
    const newRef = equipmentRef.doc();
    newEquipmentId = newRef.id;

    tx.set(newRef, {
      name,
      category,
      trackingType,
      totalQuantity,
      serialNumber,
      status,
      active: true,
      requiresApproval,
      approverId,
      customFields,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: request.auth!.uid,
    });
  });

  logger.info('addEquipment: equipment created', {
    companyId,
    equipmentId: newEquipmentId!,
    uid: request.auth.uid,
  });

  return { equipmentId: newEquipmentId!, success: true };
});
