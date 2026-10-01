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
 *
 * Issue #406: both constants are now 30 days (previously `MAIL_TTL_MS` was
 * 90 days for queued/retry/error docs). See `lib/mail-retention.ts`'s
 * docblock for the full reasoning.
 */

'use strict';

const MAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAIL_SENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Picks the `expireAt` millis for one `mail/{id}` doc, in the priority order
 * the plan for issue #325 (extended by #406) settled on:
 *
 *   1. `status === 'sent'` AND it has a `sentAt` Timestamp -> `sentAt` + 30d
 *      (matches what a writer sent through `mailDelivery.ts` today would get).
 *   2. It has a `failedAt` Timestamp (an `'error'` doc) -> `failedAt` + 30d.
 *   3. Neither -> the document's own Firestore `createTime` + 30d.
 *
 * Since #406, `MAIL_TTL_MS` and `MAIL_SENT_TTL_MS` are both 30 days, so all
 * three branches add the same duration — the branches stay separate because
 * each still anchors to a different field, which matters for docs that
 * already carry an `expireAt` computed under the old 90-day rule (see
 * `pickShortenedExpireAtMillis` below).
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
 * header docblock for why). Since #406, `computeExpireAtMillis` never
 * anchors further than 30 days out (an anchor timestamp is always <= now,
 * by construction), so `over_30d_unexpected` is a sanity bucket that should
 * always read 0 — anything landing there means an anchor field is wrong
 * (e.g. a future-dated `sentAt`/`failedAt`), not an expected outcome.
 */
function classifyBucket(expireAtMillis, nowMillis) {
  const deltaMs = expireAtMillis - nowMillis;
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  if (deltaMs <= 0) return 'already_expired';
  if (deltaMs <= THIRTY_DAYS_MS) return 'under_30d';
  return 'over_30d_unexpected';
}

/**
 * The never-extend guard for docs that ALREADY carry an `expireAt` (issue
 * #406's backfill: pre-existing docs may still hold a 90-day value computed
 * before this change). Returns the millis to write, or `null` when nothing
 * should be written.
 *
 *   - No existing `expireAt` (`existingExpireAtMillis` is not a number) ->
 *     always write the freshly computed value ("stamped").
 *   - An existing `expireAt` that is LATER than the freshly computed value
 *     -> shorten it to the computed value ("shortened"). This is the normal
 *     case for a doc whose `expireAt` was set under the old 90-day rule.
 *   - An existing `expireAt` that is already <= the computed value -> leave
 *     it alone ("unchanged"). The value is never extended, even if the
 *     freshly computed anchor would imply a later date than what's already
 *     stored — e.g. a doc re-computed with a different anchor field between
 *     runs.
 *
 * Pure and Firestore-free so it's unit-testable on its own — see this
 * module's own docblock for why that matters.
 */
function pickShortenedExpireAtMillis({ existingExpireAtMillis, computedExpireAtMillis }) {
  if (typeof existingExpireAtMillis !== 'number') {
    return { action: 'stamped', expireAtMillis: computedExpireAtMillis };
  }
  if (computedExpireAtMillis < existingExpireAtMillis) {
    return { action: 'shortened', expireAtMillis: computedExpireAtMillis };
  }
  return { action: 'unchanged', expireAtMillis: existingExpireAtMillis };
}

module.exports = {
  MAIL_TTL_MS,
  MAIL_SENT_TTL_MS,
  computeExpireAtMillis,
  classifyBucket,
  pickShortenedExpireAtMillis,
};
