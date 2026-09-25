import * as functions from 'firebase-functions/v1';
import { logger } from 'firebase-functions/v2';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { MembershipDocument } from '../types';
import { memberCountsDelta } from '../companyStats';
import { blockMemberWrite } from '../company/acceptsMembers';
import { toRole } from './role';

/**
 * Triggered when a new Firebase Auth user is created.
 * Scans the invitations collection-group for pending invitations matching
 * the new user's email. That collection group has TWO kinds of docs sharing
 * one `email`/`status` shape — the private `companies/{cid}/invitations/{id}`
 * doc (written by actions/team.ts, carries `token`/`role`, no `companyId`
 * field) and its public mirror at the top-level `invitations/{token}` (carries
 * `companyId`/`inviteId`, no `token`/`role`). The query matches both, so the
 * mirror docs are skipped up front (see the `parent.parent` check below) and
 * `companyId` is always read from the private doc's own path, never from a
 * field — the private doc has no such field to read (issue #396). For each
 * remaining (private) match:
 *   1. Creates companies/{cid}/members/{uid}
 *   2. Creates users/{uid}/memberships/{cid}
 *   3. Writes name + email to users/{uid}
 *   4. Marks the invitation accepted (subcollection, plus the mirror when one
 *      can be found)
 *   5. Sets custom claims — but only when step 1-4 actually created a member;
 *      see the `accepted` flag below.
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
    // The collection group query above matches the top-level `invitations`
    // mirror docs too (same `email`/`status` fields as the private
    // subcollection docs) — a doc at `invitations/{token}` has no parent
    // document, only the top-level collection, so `ref.parent.parent` is
    // `null` for it. Skip it here rather than filtering the query itself:
    // there's no Firestore query that tells the two apart by path shape.
    const companyRef = inviteDoc.ref.parent.parent;
    if (companyRef === null) {
      continue;
    }

    try {
      const inviteData = inviteDoc.data();
      // companyId comes from the path, not a field — the private doc (see
      // actions/team.ts) never stores its own companyId, only the mirror
      // does. Reading `inviteData.companyId` here silently produced
      // `companies/undefined` for every real invitation (issue #396); the
      // path is the one thing that's always correct.
      const companyId = companyRef.id;
      const token: unknown = inviteData.token;
      const role: MembershipDocument['role'] = toRole(inviteData.role, {
        fn: 'onUserCreate',
        path: inviteDoc.ref.path,
      });
      const now = Timestamp.now();
      const nowIso = now.toDate().toISOString();

      const memberRef = db.doc(`companies/${companyId}/members/${uid}`);
      const userMembershipRef = db.doc(`users/${uid}/memberships/${companyId}`);
      const userRef = db.doc(`users/${uid}`);

      // Every invite written by actions/team.ts carries a token, so a
      // missing/malformed one means a hand-edited or corrupt doc rather than
      // a normal case. Don't let it fail the whole invitation over a doc
      // that's only there to redirect the /invite/{token} page — fall back
      // to updating the subcollection doc alone.
      const hasValidToken = typeof token === 'string' && token.length > 0;
      if (!hasValidToken) {
        logger.warn('onUserCreate: invitation has no usable token, skipping mirror update', {
          uid: uid.slice(0, 8) + '...',
          companyId,
          inviteId: inviteDoc.id,
        });
      }
      const mirrorRef = hasValidToken ? db.collection('invitations').doc(token as string) : null;

      // `accepted` is set to true only inside the one branch that actually
      // creates the member doc — every early `return` below leaves it
      // `false`. It's how the code after the transaction knows whether to
      // touch custom claims at all: without it, a skipped invitation (already
      // a member, or a blocked company) would still hand the user an
      // `activeCompanyId` claim for a company they never joined.
      let accepted = false;

      await db.runTransaction(async (tx) => {
        // Guard: don't create duplicate member
        //
        // This `return` is INSIDE the transaction callback — it commits an
        // empty transaction rather than aborting the whole runTransaction
        // call. That's why the increment below sits after this guard rather
        // than, say, wrapping the whole callback: placed here, it only ever
        // runs on the branch that actually creates a new member doc.
        const companyDocRef = db.doc(`companies/${companyId}`);
        const [existingMember, companySnap] = await Promise.all([tx.get(memberRef), tx.get(companyDocRef)]);
        if (existingMember.exists) {
          logger.warn('onUserCreate: member already exists, skipping', {
            uid: uid.slice(0, 8) + '...',
            companyId,
          });
          return;
        }

        // The same `blockMemberWrite` guard acceptInvitation.ts uses — this
        // is the OTHER way an invitation becomes a membership (a brand-new
        // signup whose address had a pending invite), and leaving it out
        // would make "you can't join a company being deleted" true only for
        // people who already had an account.
        //
        // Same empty-commit `return` as the duplicate-member guard above,
        // not a throw: this invitation stays pending, the loop moves on to
        // this user's other invitations, and the purge's invitation phase
        // deletes it along with everything else under the company.
        const block = blockMemberWrite(companySnap);
        if (block) {
          logger.warn('onUserCreate: company cannot accept new members, skipping invitation', {
            uid: uid.slice(0, 8) + '...',
            companyId,
            reason: block.code,
          });
          return;
        }

        memberCountsDelta(tx, db, companyId, { members: 1, admins: role === 'admin' ? 1 : 0 });

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

        // 5. Mark mirror accepted, when there is one to update — see the
        // hasValidToken check above.
        if (mirrorRef) {
          tx.update(mirrorRef, { status: 'accepted' });
        }

        accepted = true;
      });

      if (!accepted) {
        continue;
      }

      // 6. Set custom claims if user has no activeCompanyId yet
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
      // Log a message/code, never the raw error object — Cloud Logging
      // splits a multi-line console.error payload into one log entry per
      // line (see project_cloud_logging_multiline in memory), and the raw
      // error can carry the invitee's email inside a Firestore error message.
      logger.error('onUserCreate: invitation processing failed', {
        uid: uid.slice(0, 8) + '...',
        inviteId: inviteDoc.id,
        message: err instanceof Error ? err.message : String(err),
        code: (err as { code?: unknown })?.code,
      });
    }
  }
});
