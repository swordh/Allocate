import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { MembershipDocument } from '../types';
import { memberCountsDelta } from '../companyStats';
import { blockMemberWrite } from '../company/acceptsMembers';
import { toRole } from './role';

/**
 * Callable function for already-authenticated users accepting an invite via link.
 *
 * @param data.token - The 32-char invite token from the invite URL
 * @returns { success: true, companyId }
 * @throws unauthenticated     if caller is not signed in
 * @throws invalid-argument    if token is missing or malformed
 * @throws not-found           if no matching pending invitation exists
 * @throws permission-denied   if the caller's email doesn't match the invite
 * @throws deadline-exceeded   if the invitation's expiresAt has passed
 * @throws already-exists      if caller is already a member of the company
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

    // Canonical rule lives in lib/invite-token.ts:isInviteExpired — duplicated
    // here because Cloud Functions is a separate compilation unit and cannot
    // import from lib/. Missing expiresAt means "never expires" (backward
    // compat for invitations created before this field existed).
    const expiresAt = mirror['expiresAt'] as string | undefined;
    if (expiresAt && Date.parse(expiresAt) < Date.now()) {
      throw new HttpsError('deadline-exceeded', 'This invitation has expired.');
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
    const role: MembershipDocument['role'] = toRole(inviteData['role'], {
      fn: 'acceptInvitation',
      path: inviteRef.path,
    });
    const displayName = explicitName ?? request.auth.token.name ?? callerEmail;

    // ── Transaction ───────────────────────────────────────────────────────────
    let txSucceeded = false;
    try {
      await db.runTransaction(async (tx) => {
        const companyRef = db.doc(`companies/${companyId}`);
        const [existingMember, companySnap] = await Promise.all([tx.get(memberRef), tx.get(companyRef)]);
        if (existingMember.exists) {
          throw new HttpsError('already-exists', 'You are already a member of this company.');
        }

        // Refuse to join a company that is gone or on its way out (issue #252
        // step 5) — see `blockMemberWrite`'s docblock for why this is a
        // mechanical guard and not a product restriction. Read inside the
        // transaction, before any write, so a deletion requested between the
        // page load and this call cannot slip past.
        const block = blockMemberWrite(companySnap);
        if (block) {
          throw new HttpsError(
            block.code === 'not-found' ? 'not-found' : 'failed-precondition',
            block.message,
          );
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

        // 1b. Apply the member-counts delta: companies/{companyId}/_meta/memberCounts
        // (members + admins) and its companies/{companyId}.stats.memberCount
        // mirror. Deliberately inside this transaction, not after it: the
        // outer catch below swallows HttpsError('already-exists') when a
        // concurrent call to this same function (e.g. the invite link
        // double-clicked, or opened in two tabs) wins the race, and because
        // these increments live in the same transaction as the tx.set above,
        // that whole transaction (including these increments) is discarded
        // on that path rather than committed — so the race can never
        // double-count either counter. (onUserCreate is a no-op as of issue
        // #396 and is not a party to this race any more — see its doc
        // comment.)
        // Fragile: if this call is ever moved outside the transaction (e.g.
        // to a best-effort write after commit), that guarantee breaks and the
        // race becomes double-countable.
        memberCountsDelta(tx, db, companyId, { members: 1, admins: role === 'admin' ? 1 : 0 });

        // 2. Create membership under user
        const membership: MembershipDocument = {
          companyId,
          role,
          joinedAt: now,
        };
        tx.set(userMembershipRef, membership);

        // 2b. Clear any scheduled account deletion (types/user.ts,
        // `PendingAccountDeletion`) in the SAME transaction as the
        // membership write above, not as a follow-up that could be
        // skipped. Accepting an invitation is a second route back to
        // having a company, alongside `setupNewCompany` (actions/auth.ts)
        // — the reasoning is identical for both: having a company at all
        // is the cancellation condition ("Avbrottsvillkoret" in
        // plan/det-k-nns-som-att-stateless-conway.md), not any one specific
        // way of getting one. Harmless when the field was never set
        // (`FieldValue.delete()` on an absent field is a no-op).
        tx.set(userRef, { pendingDeletion: FieldValue.delete() }, { merge: true });

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
        // A concurrent call to this same function beat us to creating the
        // member doc — the classic double-click / two-tabs case, not
        // onUserCreate (a no-op as of issue #396: it no longer creates
        // members, so it can't be the other side of this race any more).
        // That's fine either way — the invite is idempotent from the
        // caller's point of view. We still need to write users/{uid}
        // name+email below.
        logger.info('acceptInvitationByToken: onUserCreate already created member doc', {
          uid: uid.slice(0, 8) + '...',
          companyId,
        });
      } else {
        throw err;
      }
    }

    // Always write name + email to user root doc — runs regardless of which
    // call won the race. Also clears `pendingDeletion` here, same reasoning
    // as the in-transaction clear above: it's a harmless no-op when the
    // field was never set, and it costs nothing to do it unconditionally
    // rather than branch on which call won.
    await userRef.set({ name: displayName, email: callerEmail, pendingDeletion: FieldValue.delete() }, { merge: true });

    // ── Set custom claims if none exist (only when we ran the full tx) ────────
    // If the losing side of a concurrent-call race, the winning call already
    // set claims — skip here to avoid churn.
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
