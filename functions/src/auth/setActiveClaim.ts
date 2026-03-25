import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { MembershipDocument } from '../types';

/**
 * Updates the caller's active company in their Firebase Custom Claims.
 * Client must call getIdToken(true) after this to refresh the JWT.
 *
 * @param data.companyId - The company to switch to
 * @returns { success: true }
 * @throws unauthenticated   if caller is not signed in
 * @throws invalid-argument  if companyId is missing
 * @throws permission-denied if caller has no membership in the target company
 * Side effects: updates Firebase Custom Claims { activeCompanyId, role },
 *               updates /users/{uid}.activeCompanyId
 */
export const setActiveClaim = onCall(async (request) => {
  // ── Auth guard ─────────────────────────────────────────────────────────────
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in.');
  }

  const uid = request.auth.uid;

  // ── Input validation ───────────────────────────────────────────────────────
  const rawCompanyId: unknown = request.data.companyId;

  if (typeof rawCompanyId !== 'string' || rawCompanyId.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'companyId is required.');
  }

  const companyId = rawCompanyId.trim();

  // ── Membership verification ────────────────────────────────────────────────
  const db = getFirestore();
  const membershipRef = db.doc(`users/${uid}/memberships/${companyId}`);
  const membership = await membershipRef.get();

  if (!membership.exists) {
    throw new HttpsError('permission-denied', 'You are not a member of this company.');
  }

  const { role } = membership.data() as MembershipDocument;

  // ── Set Custom Claims ──────────────────────────────────────────────────────
  await getAuth().setCustomUserClaims(uid, {
    activeCompanyId: companyId,
    role,
  });

  // ── Sync activeCompanyId on the user document ──────────────────────────────
  // Keeps the user document consistent with the active claim so other
  // server-side reads can use it without decoding the JWT.
  await db.doc(`users/${uid}`).update({ activeCompanyId: companyId });

  logger.info('setActiveClaim: claim updated', { uid, companyId, role });

  return { success: true };
});
