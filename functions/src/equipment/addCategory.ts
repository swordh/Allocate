import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

/**
 * Creates a new custom category for a company's equipment list.
 * Duplicate category names (case-insensitive) are rejected so the
 * equipment form never shows ambiguous options.
 *
 * @param data.companyId  - Company to add the category to
 * @param data.name       - Category display name (required, max 50 chars)
 * @returns { categoryId: string, success: true }
 * @throws unauthenticated   if caller is not signed in
 * @throws permission-denied if companyId does not match the caller's activeCompanyId claim
 * @throws permission-denied if caller's role is not 'admin'
 * @throws invalid-argument  if companyId or name are missing or invalid
 * @throws already-exists    if a category with the same name (case-insensitive) already exists
 */
export const addCategory = onCall({ region: 'europe-west1', cors: true, invoker: 'public' }, async (request) => {
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

  // ── Input validation ───────────────────────────────────────────────────────
  const rawName: unknown = request.data.name;
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'name is required.');
  }
  if (rawName.trim().length > 50) {
    throw new HttpsError('invalid-argument', 'name must be 50 characters or fewer.');
  }
  const name = rawName.trim();

  // ── Duplicate check (case-insensitive) ────────────────────────────────────
  // Firestore does not support case-insensitive queries natively. We fetch all
  // category names for the company and compare in memory. This collection is
  // bounded by human-scale additions (tens, not thousands) so the full read is
  // acceptable and avoids denormalising a lowercase field just for this check.
  const db = getFirestore();
  const categoriesRef = db.collection(`companies/${companyId}/categories`);
  const existingSnap = await categoriesRef.get();

  const nameLower = name.toLowerCase();
  const duplicate = existingSnap.docs.some(
    (doc) => (doc.data()['name'] as string).toLowerCase() === nameLower,
  );

  if (duplicate) {
    throw new HttpsError(
      'already-exists',
      `A category named "${name}" already exists.`,
    );
  }

  // ── Create document ────────────────────────────────────────────────────────
  const newCategoryRef = categoriesRef.doc();
  await newCategoryRef.set({
    name,
    createdAt: FieldValue.serverTimestamp(),
    isDefault: false,
  });

  logger.info('addCategory: category created', {
    companyId,
    categoryId: newCategoryRef.id,
    name,
    uid: request.auth.uid,
  });

  return { categoryId: newCategoryRef.id, success: true };
});
