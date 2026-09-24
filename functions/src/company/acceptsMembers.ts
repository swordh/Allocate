import type { DocumentSnapshot } from 'firebase-admin/firestore';

/**
 * Why a company may not be written a new member into, or `null` when it may.
 *
 *   - `not-found` — the company document is gone. Joining it would hand the
 *     user an `activeCompanyId` claim pointing at nothing, which is the exact
 *     dead end issue #252 exists to remove.
 *   - `deleting`  — a deletion is scheduled or running
 *     (`companies/{cid}.deletion` is present). Everything the caller is about
 *     to write — the member doc, the membership pointer, the member counters,
 *     the accepted invitation — lands under a company the purge is about to
 *     delete.
 */
export type MemberWriteBlock = { code: 'not-found' | 'deleting'; message: string } | null;

/**
 * The shared guard behind the two — and only two — paths that turn an
 * invitation into a membership: `acceptInvitationByToken`
 * (functions/src/auth/acceptInvitation.ts, for someone who already has an
 * account) and `onUserCreate` (functions/src/auth/onUserCreate.ts, for a
 * brand-new signup whose address had a pending invite).
 *
 * Extracted rather than written twice because the two used to be the classic
 * pair that drifts: the same rule, enforced in two files, with only one of
 * them updated. Having it here also makes it testable at all — both callers
 * are Cloud Functions wrappers (`onCall` / `beforeUserCreated`) whose bodies
 * cannot be invoked directly from the emulator suite, which is precisely the
 * "write the logic as exported pure functions, keep the trigger a thin
 * wrapper" rule the step 5 plan sets out under PR A.
 *
 * IMPORTANT — this is NOT one of the product restrictions the design brief
 * rules out. The brief is explicit that inviting people during the seven-day
 * window stays allowed, and that no other gate appears: "Vi bygger inga
 * hinder som sedan måste underhållas." This guard exists for a mechanical
 * reason instead — not writing into a document that is on its way out — and
 * it is self-releasing, because a cancelled deletion removes the `deletion`
 * field entirely. Nothing has to remember to re-open invitations.
 *
 * Presence of `deletion` is the whole check, deliberately: there is no
 * "cancelled" value in that object (see `CompanyDeletionState` in
 * types/company.ts), so a `state === 'requested'` comparison here would let
 * somebody join a company mid-purge — the one moment it is most wrong.
 */
export function blockMemberWrite(companySnap: DocumentSnapshot): MemberWriteBlock {
  if (!companySnap.exists) {
    return { code: 'not-found', message: 'That company no longer exists.' };
  }
  const deletion = companySnap.data()?.['deletion'] as { state?: string } | undefined;
  if (deletion) {
    // 'requested' is the only state a "stop the deletion first" message is
    // TRUE for — only then does an admin have anything left to stop.
    // 'executing' and 'failed' (issue #331: the mirror can now carry
    // 'failed', not just 'requested'/'executing') both describe a purge
    // that has already started running, cancelling nothing is possible from
    // here, and telling someone to "stop" it would send them looking for a
    // button that doesn't exist.
    const message =
      deletion.state === 'requested'
        ? 'This company is scheduled for deletion and is not accepting new members. Ask an administrator to stop the deletion first.'
        : 'This company is being deleted and is not accepting new members.';
    return { code: 'deleting', message };
  }
  return null;
}
