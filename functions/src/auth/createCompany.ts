import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { PLAN_LIMITS } from '../types';

/**
 * Creates a new company and sets the caller as Admin.
 * Called immediately after Firebase Auth sign-up.
 *
 * @param data.companyName - Display name for the company (max 100 chars)
 * @param data.userName    - Display name for the user (max 100 chars)
 * @returns { companyId: string, success: true }
 * @throws unauthenticated   if caller is not signed in
 * @throws invalid-argument  if companyName or userName is missing or too long
 * @throws already-exists    if the calling user already has a membership document
 * Side effects: creates /companies/{id}, /users/{uid}, /users/{uid}/memberships/{id},
 *               sets Custom Claims { activeCompanyId, role: "admin" }
 * Note: Stripe Customer creation is deferred to Phase 4. stripeCustomerId is left empty.
 */
export const createCompany = onCall({ cors: true, invoker: 'public' }, async (request) => {
  // ── Auth guard ─────────────────────────────────────────────────────────────
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in.');
  }

  const uid = request.auth.uid;

  // ── Input validation ───────────────────────────────────────────────────────
  const rawCompanyName: unknown = request.data.companyName;
  const rawUserName: unknown = request.data.userName;

  if (typeof rawCompanyName !== 'string' || rawCompanyName.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'companyName is required.');
  }
  if (rawCompanyName.trim().length > 100) {
    throw new HttpsError('invalid-argument', 'companyName must be 100 characters or fewer.');
  }
  if (typeof rawUserName !== 'string' || rawUserName.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'userName is required.');
  }
  if (rawUserName.trim().length > 100) {
    throw new HttpsError('invalid-argument', 'userName must be 100 characters or fewer.');
  }

  const companyName = rawCompanyName.trim();
  const userName = rawUserName.trim();

  const db = getFirestore();

  // ── Idempotency guard — one company per sign-up ────────────────────────────
  // Check the caller's own membership subcollection. If any document exists,
  // a company was already created for this user.
  const membershipCollectionRef = db.collection(`users/${uid}/memberships`);
  const existingSnapshot = await membershipCollectionRef.limit(1).get();

  if (!existingSnapshot.empty) {
    throw new HttpsError('already-exists', 'User already belongs to a company.');
  }

  // ── Document references ────────────────────────────────────────────────────
  const newCompanyRef = db.collection('companies').doc();
  const newCompanyId = newCompanyRef.id;
  const userRef = db.doc(`users/${uid}`);
  const membershipRef = db.doc(`users/${uid}/memberships/${newCompanyId}`);

  // ── Batched write — all Firestore documents written atomically ─────────────
  const batch = db.batch();

  batch.set(newCompanyRef, {
    name: companyName,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: uid,
    stripeCustomerId: '', // populated in Phase 4 when Stripe is wired up
    hadTrial: false,
    subscription: {
      status: 'trialing',
      plan: 'basic',
      limits: PLAN_LIMITS.basic,
      currentPeriodEnd: null,
      trialEnd: null,
      cancelAtPeriodEnd: false,
    },
  });

  batch.set(userRef, {
    name: userName,
    email: request.auth.token.email ?? '',
    activeCompanyId: newCompanyId,
    createdAt: FieldValue.serverTimestamp(),
  });

  batch.set(membershipRef, {
    companyId: newCompanyId, // explicit field — required for collectionGroup GDPR queries
    role: 'admin',
    joinedAt: FieldValue.serverTimestamp(),
  });

  // ── Seed default categories ────────────────────────────────────────────────
  // Six default categories are created for every new company so the equipment
  // add form has sensible options immediately. They are marked isDefault: true
  // so the UI can distinguish them from user-created categories.
  const DEFAULT_CATEGORIES = ['Camera', 'Lenses', 'Audio', 'Lighting', 'Grip', 'Accessories'];
  for (const categoryName of DEFAULT_CATEGORIES) {
    const categoryRef = db.collection(`companies/${newCompanyId}/categories`).doc();
    batch.set(categoryRef, {
      name: categoryName,
      createdAt: FieldValue.serverTimestamp(),
      isDefault: true,
    });
  }

  try {
    await batch.commit();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('createCompany: batch write failed', { uid, error: message });
    throw new HttpsError('internal', 'Failed to create company. Please try again.');
  }

  // ── Custom Claims ──────────────────────────────────────────────────────────
  // Set after the batch succeeds so claims are only active when data exists.
  try {
    await getAuth().setCustomUserClaims(uid, {
      activeCompanyId: newCompanyId,
      role: 'admin',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('createCompany: setCustomUserClaims failed', { uid, newCompanyId, error: message });
    // Documents are already written. Log the failure so it can be repaired,
    // but do not surface an internal error to the client — the user can call
    // setActiveClaim to recover the claims on next sign-in.
    throw new HttpsError('internal', 'Company created but claims could not be set. Please sign in again.');
  }

  logger.info('createCompany: company created', { uid, companyId: newCompanyId });

  return { companyId: newCompanyId, success: true };
});
