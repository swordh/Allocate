/**
 * Pure decision logic for `tools/backfill_invitation_mirrors.js` (issue
 * #297) — separated out (same reasoning as `tools/lib/mailExpireAtCompute.js`
 * and `tools/lib/mask_pii.js`) so it can be unit-tested without pulling in
 * `firebase-admin/app`'s `initializeApp`, which the backfill script runs at
 * module load time.
 *
 * This covers ONLY the top-level `invitations/{token}` mirror collection,
 * never the private `companies/{cid}/invitations/*` docs — see this
 * script's own header docblock, and `mirrorExpireAt`'s docblock in
 * `actions/team.ts`, for why the two must never be conflated.
 *
 * Per mirror, in priority order:
 *   1. `status !== 'pending'` (accepted/revoked, or any other legacy value)
 *      -> delete outright. Accept/revoke now delete the mirror themselves
 *      going forward, but this backfill still needs to clean up whatever
 *      was written before this PR shipped.
 *   2. `status === 'pending'` with an `expiresAt` and no `expireAt` yet
 *      -> stamp `expireAt` from `expiresAt`.
 *   3. `status === 'pending'` with NO `expiresAt` at all (legacy — written
 *      before invite expiry existed, "never expires") -> skip. Deciding
 *      what to do with these is a separate call, so this backfill only
 *      counts them rather than guessing an expiry.
 *   4. `status === 'pending'` that already has `expireAt` -> nothing to do,
 *      counted as already-ok (freshly written by this PR's own writers, or
 *      already backfilled by an earlier run of this exact script).
 */

'use strict';

/**
 * @param {{ status?: unknown, expiresAt?: unknown, expireAt?: unknown }} data
 * @returns {
 *   | { action: 'delete' }
 *   | { action: 'set_expire_at', expireAtMillis: number }
 *   | { action: 'skip_no_expiry' }
 *   | { action: 'ok' }
 * }
 */
function decideMirrorAction(data) {
  const status = data.status;

  if (status !== 'pending') {
    return { action: 'delete' };
  }

  const hasExpireAt = data.expireAt !== undefined;
  if (hasExpireAt) {
    return { action: 'ok' };
  }

  const expiresAt = data.expiresAt;
  if (typeof expiresAt !== 'string') {
    return { action: 'skip_no_expiry' };
  }

  const millis = Date.parse(expiresAt);
  if (Number.isNaN(millis)) {
    // Malformed ISO string — treat the same as "no expiry" rather than
    // stamping a garbage TTL value. Counted separately by the caller if it
    // wants to (this module only reports the decision, not why).
    return { action: 'skip_no_expiry' };
  }

  return { action: 'set_expire_at', expireAtMillis: millis };
}

module.exports = { decideMirrorAction };
