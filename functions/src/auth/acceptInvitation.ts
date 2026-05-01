import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { MembershipDocument } from '../types';

/**
 * Callable function for already-authenticated users accepting an invite via link.
 *
 * @param data.token - The 20-char invite token from the invite URL
 * @returns { success: true, companyId }
 * @throws unauthenticated   if caller is not signed in
 * @throws invalid-argument  if token is missing or malformed
 * @throws not-found         if no matching pending invitation exists
 * @throws already-exists    if caller is already a member of the company
 */
export const acceptInvitationByToken = onCall(
  { region: 'europe-west1', cors: true, invoker: 'public' },
  async (request) => {
    // ── Auth guard ────────────────────────────────────────────────────────────
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in.');
    }

    const uid = request.auth.uid;
    const callerEmail = (request.auth.token.email ?? '').toLowerCase();

    // ── Input validation ──────────────────────────────────────────────────────
    const rawToken: unknown = request.data.token;
    if (typeof rawToken !== 'string' || rawToken.trim().length === 0) {
      throw new HttpsError('invalid-argument', 'token is required.');
    }

    const token = rawToken.trim();

    const rawName: unknown = request.data.name;
    const explicitName =
      typeof rawName === 'string' && rawName.trim().length > 0
        ? rawName.trim()
        : undefined;
    const db = getFirestore();

    // ── Resolve mirror doc ────────────────────────────────────────────────────
    const mirrorRef = db.collection('invitations').doc(token);
    const mirrorSnap = await mirrorRef.get();

    if (!mirrorSnap.exists) {
      throw new HttpsError('not-found', 'Invitation not found or already used.');
    }

    const mirror = mirrorSnap.data()!;

    if (mirror['status'] !== 'pending') {
      throw new HttpsError('not-found', 'This invitation link has already been used or revoked.');
    }

    const companyId: string = mirror['companyId'];
    const inviteId: string = mirror['inviteId'];
    const inviteEmail: string = (mirror['email'] as string).toLowerCase();

    // ── Email must match ──────────────────────────────────────────────────────
    if (callerEmail !== inviteEmail) {
      throw new HttpsError(
        'permission-denied',
        'This invitation was sent to a different email address.',
      );
    }

    const inviteRef = db.doc(`companies/${companyId}/invitations/${inviteId}`);
    const memberRef = db.doc(`companies/${companyId}/members/${uid}`);
    const userMembershipRef = db.doc(`users/${uid}/memberships/${companyId}`);
    const userRef = db.doc(`users/${uid}`);

    const now = Timestamp.now();
    const nowIso = now.toDate().toISOString();

    // ── Resolve invite role ───────────────────────────────────────────────────
    const inviteSnap = await inviteRef.get();
    if (!inviteSnap.exists) {
      throw new HttpsError('not-found', 'Invitation record not found.');
    }

    const inviteData = inviteSnap.data()!;
    const role: MembershipDocument['role'] = inviteData['role'] ?? 'crew';
    const displayName = explicitName ?? request.auth.token.name ?? callerEmail;

    // ── Transaction ───────────────────────────────────────────────────────────
    let txSucceeded = false;
    try {
      await db.runTransaction(async (tx) => {
        const existingMember = await tx.get(memberRef);
        if (existingMember.exists) {
          throw new HttpsError('already-exists', 'You are already a member of this company.');
        }

        // 1. Create member under company
        tx.set(memberRef, {
          uid,
          name: displayName,
          email: callerEmail,
          role,
          joinedAt: now,
          companyId,
        });

        // 2. Create membership under user
        const membership: MembershipDocument = {
          companyId,
          role,
          joinedAt: now,
        };
        tx.set(userMembershipRef, membership);

        // 3. Mark invitation accepted
        tx.update(inviteRef, {
          status: 'accepted',
          acceptedAt: nowIso,
          acceptedBy: uid,
        });

        // 4. Mark mirror accepted
        tx.update(mirrorRef, { status: 'accepted' });
      });
      txSucceeded = true;
    } catch (err) {
      if (err instanceof HttpsError && err.code === 'already-exists') {
        // onUserCreate beat us to creating the member doc — that is fine.
        // We still need to write users/{uid} name+email below.
        logger.info('acceptInvitationByToken: onUserCreate already created member doc', {
          uid: uid.slice(0, 8) + '...',
          companyId,
        });
      } else {
        throw err;
      }
    }

    // Always write name + email to user root doc — runs regardless of which
    // path won the race (callable tx or onUserCreate trigger).
    await userRef.set({ name: displayName, email: callerEmail }, { merge: true });

    // ── Set custom claims if none exist (only when we ran the full tx) ────────
    // If onUserCreate won the race, it already set claims — skip to avoid churn.
    if (txSucceeded) {
      const existingClaims = (request.auth.token ?? {}) as Record<string, unknown>;
      if (!existingClaims['activeCompanyId']) {
        await getAuth().setCustomUserClaims(uid, {
          activeCompanyId: companyId,
          role,
        });

        await userRef.set({ activeCompanyId: companyId }, { merge: true });
      }
    }

    logger.info('acceptInvitationByToken: accepted', {
      uid: uid.slice(0, 8) + '...',
      companyId,
      inviteId,
    });

    return { success: true, companyId };
  },
);
