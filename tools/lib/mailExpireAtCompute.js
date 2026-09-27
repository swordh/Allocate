/**
 * Pure `expireAt` computation for `tools/backfill_mail_expire_at.js` —
 * separated out (same reasoning as `tools/lib/mask_pii.js`) so it can be
 * unit-tested without pulling in `firebase-admin/app`'s `initializeApp`,
 * which the backfill script runs at module load time.
 *
 * `MAIL_TTL_MS`/`MAIL_SENT_TTL_MS` are a THIRD copy of the constants in
 * `lib/mail-retention.ts` and `functions/src/email/mailRetention.ts` — this
 * is a plain Node script with no bundler, so it can't import either TS
 * module directly, the same constraint that keeps those two from importing
 * each other. Keep all three in lockstep by hand if the retention windows
 * ever change.
 */

'use strict';

const MAIL_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAIL_SENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Picks the `expireAt` millis for one `mail/{id}` doc that's missing the
 * field, in the priority order the plan for issue #325 settled on:
 *
 *   1. `status === 'sent'` AND it has a `sentAt` Timestamp -> `sentAt` + 30d
 *      (matches what a writer sent through `mailDelivery.ts` today would get).
 *   2. It has a `failedAt` Timestamp (an `'error'` doc) -> `failedAt` + 90d.
 *   3. Neither -> the document's own Firestore `createTime` + 90d.
 *
 * Deliberately never `createdAt` — six of the twelve writers never set that
 * field at all, and where it does exist it's an ISO STRING (`new
 * Date().toISOString()`), not a Timestamp; parsing it back out would need a
 * fourth code path for no real gain when `createTime` (a property every
 * Firestore document has, written by Firestore itself, never missing) already
 * covers the same "when was this queued" question exactly.
 *
 * All three inputs are already-resolved millis (a `Timestamp`'s `.toMillis()`
 * has to happen at the call site, where the actual Firestore document/data
 * types are in scope) — kept that way so this function has zero Firestore
 * imports and is trivial to unit test with plain numbers.
 */
function computeExpireAtMillis({ status, sentAtMillis, failedAtMillis, createTimeMillis }) {
  if (status === 'sent' && typeof sentAtMillis === 'number') {
    return sentAtMillis + MAIL_SENT_TTL_MS;
  }
  if (typeof failedAtMillis === 'number') {
    return failedAtMillis + MAIL_TTL_MS;
  }
  return createTimeMillis + MAIL_TTL_MS;
}

/**
 * Buckets a computed `expireAt` relative to `nowMillis`, for the backfill's
 * summary report — issue #325's plan requires the script to print ONLY
 * counts per bucket, never an address, name or doc id (see the script's own
 * header docblock for why). Three buckets cover every case
 * `computeExpireAtMillis` can produce: the largest possible delta from `now`
 * is 90 days (an anchor timestamp is always <= now, by construction), so
 * nothing ever lands beyond `30_to_90d`.
 */
function classifyBucket(expireAtMillis, nowMillis) {
  const deltaMs = expireAtMillis - nowMillis;
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  if (deltaMs <= 0) return 'already_expired';
  if (deltaMs < THIRTY_DAYS_MS) return 'under_30d';
  return '30_to_90d';
}

module.exports = { MAIL_TTL_MS, MAIL_SENT_TTL_MS, computeExpireAtMillis, classifyBucket };
