import { createHash } from 'crypto';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';

/** Thirty days, per "Del 3" of the design brief and "Fattade beslut" in the plan. */
export const STRANDED_MEMBER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * `kept` — she had at least one other company; only the membership pointer
 *   into the purged company was removed.
 * `scheduled` — she had no other company. Her account is untouched but now
 *   carries `pendingDeletion` (thirty days out) — see the module docblock.
 * `already_gone` — `users/{uid}` did not exist when this ran. The only
 *   route to this today is the sole-member-deletes-her-own-account case
 *   (`mode: 'immediate'`, PR F): `deleteAccount` deletes her own account
 *   synchronously, before/independently of this purge, so by the time the
 *   purge's members phase reaches her there is nothing left to schedule —
 *   she is already, actually gone, not merely counting down. Callers (the
 *   finalize phase's `companyDeleted` mail) must treat this differently
 *   from `scheduled`: it is the one case where that mail's
 *   `accountAlsoDeleted: true` / "nothing left to sign back into" copy is
 *   actually true.
 */
export type MemberAccountStatus = 'kept' | 'scheduled' | 'already_gone';

export interface MemberCleanupOutcome {
  uid: string;
  accountStatus: MemberAccountStatus;
  /**
   * False only when an Auth claims update was actually NEEDED (her
   * `activeCompanyId` pointed at the company being purged) and the call to
   * `setCustomUserClaims` threw. True when no update was needed at all, or
   * when it was needed and succeeded.
   *
   * `runMembersPhase` (purge.ts) uses this to decide whether this uid may
   * be treated as done for resume purposes: a uid with `claimsUpdated:
   * false` is NOT added to the ledger's `formerMemberContacts` (the
   * per-uid resume marker), so a later resume attempt calls
   * `cleanupOneMember` for her again rather than silently leaving her
   * Auth claims pointed at a company that no longer exists. See this
   * function's own idempotency guard on the "stranded" branch below —
   * that's what makes a full re-run of an already-partially-succeeded uid
   * safe rather than a source of duplicate audit entries or a reset
   * thirty-day clock.
   */
  claimsUpdated: boolean;
  /** Only set when `accountStatus === 'scheduled'` — the thirty-day deadline just written (or already present) on `users/{uid}.pendingDeletion`. */
  pendingDeletionScheduledFor?: Timestamp;
}

/**
 * Per-member half of the purge's "members" phase. Generalizes the logic
 * `removeMember` (actions/team.ts:662-700) already has for cleaning up ONE
 * member's user-side state to N members being processed by a purge:
 *
 *   1. Delete `users/{uid}/memberships/{companyId}` — this member's pointer
 *      into the company being purged.
 *   2. If that was her active company, repoint `activeCompanyId` (and
 *      Custom Claims) to a remaining membership, or clear both to null if
 *      none remain.
 *   3. `revokeRefreshTokens` unconditionally — same reasoning as
 *      `updateMemberRole` (actions/team.ts): a cached session/claims must
 *      not keep working against a company that no longer exists for her,
 *      regardless of which branch of step 2 ran.
 *   4. If she has NO remaining memberships at all, she is stranded — see
 *      "Medlemsstädningen" and "Fattade beslut" in the plan. The purge does
 *      NOT delete her account here. It schedules the account for deletion
 *      thirty days out (`users/{uid}.pendingDeletion`, see
 *      `PendingAccountDeletion` in types/user.ts) and leaves every other
 *      part of her account exactly as it was: she can still sign in, export
 *      her data, and create a new company (which — PR F — clears this
 *      schedule in the same transaction as the new membership). The actual
 *      enforcement sweep is a separate, not-yet-built piece of work that may
 *      not go live before that create-company path exists (see the plan's
 *      "Hård ordningsregel").
 *
 * A `deletionAuditLog` entry is written for the scheduling itself, with its
 * own `triggeredBy` value distinct from `deleteAccount`'s `'user_self'` —
 * this is an administrator's decision reaching a third party's account, not
 * self-service deletion, and the audit trail needs to say so.
 *
 * Does NOT touch `companies/{companyId}/members/{uid}` — that document, and
 * the rest of the company subtree, is deleted by the purge's later
 * "subtree" phase via `recursiveDelete`. This function only ever writes
 * user-side documents.
 */
export async function cleanupOneMember(
  db: Firestore,
  companyId: string,
  uid: string,
  requestId: string,
): Promise<MemberCleanupOutcome> {
  await db.doc(`users/${uid}/memberships/${companyId}`).delete();

  const userRef = db.doc(`users/${uid}`);
  const [userSnap, remainingSnap] = await Promise.all([
    userRef.get(),
    db.collection(`users/${uid}/memberships`).get(),
  ]);
  const userData = userSnap.exists ? userSnap.data()! : {};
  const remaining = remainingSnap.docs;

  // Tracked separately from "membership pointer removed" — see
  // MemberCleanupOutcome.claimsUpdated's docblock. Stays `true` when no
  // update was needed at all (her active company was something else).
  let claimsUpdated = true;

  if (userData['activeCompanyId'] === companyId) {
    try {
      if (remaining.length > 0) {
        const next = remaining[0].data();
        const nextCompanyId = next['companyId'] as string;
        const nextRole = next['role'] as string;
        await userRef.set({ activeCompanyId: nextCompanyId }, { merge: true });
        await getAuth().setCustomUserClaims(uid, { activeCompanyId: nextCompanyId, role: nextRole });
      } else {
        await userRef.set({ activeCompanyId: null }, { merge: true });
        await getAuth().setCustomUserClaims(uid, { activeCompanyId: null, role: null });
      }
    } catch (err) {
      // NOT swallowed silently as far as the caller is concerned — see
      // claimsUpdated below. Still non-fatal to THIS function's own
      // control flow (the membership pointer is already gone regardless of
      // whether claims could be refreshed, and revokeRefreshTokens below
      // still runs unconditionally), but the caller must not treat this uid
      // as fully done.
      claimsUpdated = false;
      const message = err instanceof Error ? err.message : String(err);
      logger.error('cleanupOneMember: activeCompanyId/claims update failed', {
        uid: uid.slice(0, 8) + '...',
        companyId,
        error: message,
      });
    }
  }

  try {
    await getAuth().revokeRefreshTokens(uid);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('cleanupOneMember: revokeRefreshTokens failed', {
      uid: uid.slice(0, 8) + '...',
      companyId,
      error: message,
    });
  }

  if (remaining.length > 0) {
    return { uid, accountStatus: 'kept', claimsUpdated };
  }

  if (!userSnap.exists) {
    // deleteAccount (PR F) already deleted this user's own account, ahead of
    // (or independent of) this purge — see MemberAccountStatus's docblock.
    // Nothing left here to schedule.
    return { uid, accountStatus: 'already_gone', claimsUpdated };
  }

  // ── Stranded: schedule the account for deletion, do not delete it ────────
  //
  // Idempotency guard: a uid can reach this branch more than once for the
  // SAME purge — `runMembersPhase` deliberately re-processes any uid whose
  // claims update failed on a prior pass (see claimsUpdated above), and this
  // is the one branch that is NOT safe to blindly redo, since it writes a
  // fresh thirty-day deadline and a new audit-log row every time it runs.
  // If `pendingDeletion` already points at THIS requestId, the schedule was
  // already written by an earlier pass — reuse it rather than resetting the
  // clock or duplicating the audit entry.
  const existingPendingDeletion = userData['pendingDeletion'] as
    | { scheduledFor: Timestamp; requestId: string }
    | undefined;

  if (existingPendingDeletion && existingPendingDeletion.requestId === requestId) {
    return { uid, accountStatus: 'scheduled', claimsUpdated, pendingDeletionScheduledFor: existingPendingDeletion.scheduledFor };
  }

  const scheduledFor = Timestamp.fromMillis(Date.now() + STRANDED_MEMBER_WINDOW_MS);
  await userRef.set({ pendingDeletion: { scheduledFor, requestId } }, { merge: true });

  const userIdHash = createHash('sha256').update(uid).digest('hex');
  await db.collection('deletionAuditLog').add({
    userIdHash,
    // `scheduledAt` — when this SCHEDULE was written, not when anything was
    // deleted. Deliberately does NOT also carry `deletedAt`: nothing has
    // been deleted yet, only scheduled, and a `deletedAt` here would
    // misrepresent the event. See purgeOldAuditLogs (admin/purgeAuditLogs.ts)
    // — it queries on `scheduledAt` as well as `deletedAt` for exactly this
    // reason, so this row still ages out under the same 12-month retention
    // rule despite the different field name.
    scheduledAt: FieldValue.serverTimestamp(),
    scheduledFor,
    requestId,
    companyId,
    // Distinct from deleteAccount's 'user_self' — this account was not
    // scheduled by its own owner, it lost its only company to an
    // administrator's decision.
    triggeredBy: 'company_deletion_stranded_member',
  });

  return { uid, accountStatus: 'scheduled', claimsUpdated, pendingDeletionScheduledFor: scheduledFor };
}
