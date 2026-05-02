import * as functions from 'firebase-functions/v1';
import { logger } from 'firebase-functions/v2';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { MembershipDocument } from '../types';

/**
 * Triggered when a new Firebase Auth user is created.
 * Scans the invitations collection-group for pending invitations matching
 * the new user's email, and for each match:
 *   1. Creates companies/{cid}/members/{uid}
 *   2. Creates users/{uid}/memberships/{cid}
 *   3. Writes name + email to users/{uid}
 *   4. Marks the invitation accepted (both subcollection + mirror)
 *   5. Sets custom claims if user has no activeCompanyId yet
 *
 * Runs in europe-west1 (inherited from setGlobalOptions in index.ts).
 */
export const onUserCreate = functions
  .region('europe-west1')
  .auth.user()
  .onCreate(async (user) => {
  if (!user.email) {
    logger.info('onUserCreate: no email, skipping', { uid: user.uid.slice(0, 8) + '...' });
    return;
  }

  const email = user.email.toLowerCase();
  const uid = user.uid;
  const db = getFirestore();

  // Find all pending invitations for this email across all companies
  const invitationsSnap = await db
    .collectionGroup('invitations')
    .where('email', '==', email)
    .where('status', '==', 'pending')
    .get();

  if (invitationsSnap.empty) {
    logger.info('onUserCreate: no pending invitations', { uid: uid.slice(0, 8) + '...' });
    return;
  }

  logger.info('onUserCreate: found pending invitations', {
    uid: uid.slice(0, 8) + '...',
    count: invitationsSnap.size,
  });

  // Resolve user's display name from Auth record
  const displayName = user.displayName ?? email;

  // Process each invitation — use transactions to avoid partial writes
  for (const inviteDoc of invitationsSnap.docs) {
    const inviteData = inviteDoc.data();
    const companyId: string = inviteData.companyId;
    const token: string = inviteData.token;
    const role: MembershipDocument['role'] = inviteData.role ?? 'crew';
    const now = Timestamp.now();
    const nowIso = now.toDate().toISOString();

    const memberRef = db.doc(`companies/${companyId}/members/${uid}`);
    const mirrorRef = db.collection('invitations').doc(token);
    const userMembershipRef = db.doc(`users/${uid}/memberships/${companyId}`);
    const userRef = db.doc(`users/${uid}`);

    try {
      await db.runTransaction(async (tx) => {
        // Guard: don't create duplicate member
        const existingMember = await tx.get(memberRef);
        if (existingMember.exists) {
          logger.warn('onUserCreate: member already exists, skipping', {
            uid: uid.slice(0, 8) + '...',
            companyId,
          });
          return;
        }

        // 1. Create member doc under company
        tx.set(memberRef, {
          uid,
          name: displayName,
          email,
          role,
          joinedAt: now,
          companyId,
        });

        // 2. Create membership doc under user (for collectionGroup GDPR queries)
        const membership: MembershipDocument = {
          companyId,
          role,
          joinedAt: now,
        };
        tx.set(userMembershipRef, membership);

        // 3. Write name + email to user root doc so account page can read it
        tx.set(userRef, { name: displayName, email }, { merge: true });

        // 4. Mark invitation accepted in subcollection
        tx.update(inviteDoc.ref, {
          status: 'accepted',
          acceptedAt: nowIso,
          acceptedBy: uid,
        });

        // 5. Mark mirror accepted
        tx.update(mirrorRef, { status: 'accepted' });
      });

      // 5. Set custom claims if user has no activeCompanyId yet
      const existingClaims = (user.customClaims ?? {}) as Record<string, unknown>;
      if (!existingClaims['activeCompanyId']) {
        await getAuth().setCustomUserClaims(uid, {
          activeCompanyId: companyId,
          role,
        });

        // Sync user document
        await userRef.set(
          { activeCompanyId: companyId },
          { merge: true },
        );

        logger.info('onUserCreate: set active claim', {
          uid: uid.slice(0, 8) + '...',
          companyId,
          role,
        });
      }

      logger.info('onUserCreate: invitation accepted', {
        uid: uid.slice(0, 8) + '...',
        companyId,
        inviteId: inviteDoc.id,
      });
    } catch (err) {
      logger.error('onUserCreate: transaction failed', {
        uid: uid.slice(0, 8) + '...',
        companyId,
        inviteId: inviteDoc.id,
        error: err,
      });
    }
  }
});
