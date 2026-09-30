/**
 * Pure classification logic for `tools/backfill_feedback_closed_at.js` —
 * separated out (same reasoning as `tools/lib/mailExpireAtCompute.js` and
 * `tools/lib/mask_pii.js`) so it can be unit-tested without pulling in
 * `firebase-admin/app`'s `initializeApp`, which the backfill script runs at
 * module load time.
 *
 * `CLOSED_STATUS_LABELS` mirrors `FEEDBACK_STATUS_LABELS['done']` /
 * `['wont_fix']` (types/operator.ts) and `CLOSED_FEEDBACK_STATUSES` —
 * hardcoded rather than imported, because this runs as a plain Node CJS
 * script with no TS build step (see the backfill script's own docblock),
 * and the repo has no tsx/ts-node at the root to `require()` a `.ts` module
 * directly (confirmed: neither is a dependency here — see the mail-retention
 * constants in `tools/lib/mailExpireAtCompute.js` for the same constraint
 * applied to a different pair of constants). The event text itself is a
 * stable, already-shipped wire contract — it's rendered verbatim to
 * operators in the feedback timeline UI — not a casual literal that drifts
 * easily.
 */

'use strict';

const CLOSED_STATUS_LABELS = ['DONE', 'NO ACTION'];

/**
 * Parses `updateFeedbackStatus`'s event text contract:
 * "Status changed {FROM} → {TO}" (app/operator/(protected)/feedback/actions.ts,
 * using FEEDBACK_STATUS_LABELS). Returns null for anything that doesn't
 * match — a malformed or unrelated note is silently ignored, never mistaken
 * for a status-change event.
 */
function parseStatusChangeEvent(text) {
  const match = /^Status changed (.+) → (.+)$/.exec(text);
  if (!match) return null;
  return { from: match[1], to: match[2] };
}

/**
 * A CLOSING transition is one whose FROM is NOT already a closed status and
 * whose TO IS one. This is the fix for the bug code review caught in the
 * first version of this script: matching on the TO suffix alone
 * ("→ DONE" / "→ NO ACTION") also matches a closed → closed
 * RECLASSIFICATION event ("NO ACTION → DONE"), which `updateFeedbackStatus`
 * deliberately does NOT treat as a new `closedAt` — its own docblock calls
 * this out as "closed → closed: keep existing closedAt". Picking the most
 * recent matching event without this check would pick the reclassification
 * time instead of the ticket's actual closing time, over-estimating how
 * long it's been closed and therefore purging it later than the 24-month
 * policy intends.
 */
function isClosingTransition(from, to) {
  return CLOSED_STATUS_LABELS.includes(to) && !CLOSED_STATUS_LABELS.includes(from);
}

/**
 * Given one ticket's full notes/events timeline (as read from
 * `operatorFeedback/{id}/notes`), returns the `createdAt` of the most
 * recent CLOSING transition — matching the live state machine's semantics
 * in `updateFeedbackStatus` exactly: `closedAt` is the time of the most
 * recent transition from a non-closed status into a closed one — or `null`
 * if there is none.
 *
 * `entries` are plain objects — `{kind, text, createdAt}` — where
 * `createdAt` is anything with a `.toMillis()` method (a real Firestore
 * `Timestamp` in production, a fake with the same shape in tests). An
 * entry missing `kind: 'event'`, with non-string `text`, with unparseable
 * `text`, describing a non-closing transition, or with a missing/malformed
 * `createdAt`, is ignored — same "no usable timestamp, skip it" posture as
 * the rest of this script.
 */
function latestClosingEventCreatedAt(entries) {
  let latest = null;
  for (const entry of entries) {
    if (!entry || entry.kind !== 'event') continue;
    if (typeof entry.text !== 'string') continue;
    const parsed = parseStatusChangeEvent(entry.text);
    if (!parsed) continue;
    if (!isClosingTransition(parsed.from, parsed.to)) continue;
    const createdAt = entry.createdAt;
    if (!createdAt || typeof createdAt.toMillis !== 'function') continue;
    if (!latest || createdAt.toMillis() > latest.toMillis()) latest = createdAt;
  }
  return latest;
}

module.exports = {
  CLOSED_STATUS_LABELS,
  parseStatusChangeEvent,
  isClosingTransition,
  latestClosingEventCreatedAt,
};
