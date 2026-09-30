import { Timestamp } from 'firebase-admin/firestore';

/**
 * Mirror of `MAIL_TTL_MS`/`MAIL_SENT_TTL_MS`/`mailExpireAt`/`sentMailExpireAt`
 * in `lib/mail-retention.ts` — functions/ compiles as its own project with
 * no path alias back to the repo root, so this can't be imported, only kept
 * in lockstep by hand (same pattern as `ALLOWED_ROLES` in
 * `functions/src/auth/role.ts` ↔ `lib/roles.ts`).
 *
 * Issue #325: `mail/{id}` documents carry a recipient address in clear text,
 * often alongside a name and company, and nothing previously deleted them —
 * an unbounded-retention violation of GDPR Art. 5(1)(e). Every writer of a
 * `mail` doc now stamps `expireAt`, a Firestore TTL field (declared in
 * `firestore.indexes.json`'s `fieldOverrides`) that lets Firestore's own TTL
 * service delete the document once it passes, with no scheduled function
 * needed on our side.
 *
 * `expireAt` is a CONCRETE `Timestamp` computed at write time, never a
 * `FieldValue.serverTimestamp()` sentinel — Firestore's TTL policy reads the
 * field's stored value directly to decide when to delete a document, so it
 * needs an actual point in time already resolved by the time the write
 * lands, not a marker that only resolves to one on the server during that
 * write. Same reasoning as `ACCOUNT_DELETION_FAILURE_TTL_MS` in
 * `actions/account.ts`.
 *
 * Issue #406: the 90-day queue-time TTL above meant an undelivered mail
 * (stuck in `error` or `retry`, often because its recipient had already
 * deleted their account) sat in Firestore for up to three times as long as
 * one that was actually sent. Joakim confirmed the 90-day delivery-history
 * window was never used, so every status now gets the same 30-day clock
 * from the moment the mail is queued. `mailDelivery.ts`'s `deliverMail`
 * still re-anchors `expireAt` to `sentMailExpireAt` the moment a mail
 * reaches `status: 'sent'` — not because that TTL is shorter any more (it's
 * the same 30 days), but because it re-anchors the clock to `sentAt`
 * instead of the original queue time, which is still the right anchor for
 * a delivered mail.
 */
export const MAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How long a `mail/{id}` doc survives once it reaches `status: 'sent'`,
 *  counted from `sentAt` rather than queue time — see `MAIL_TTL_MS`'s
 *  docblock above. Deliberately equal to `MAIL_TTL_MS` (both 30 days) since
 *  issue #406; kept as its own constant/anchor because `sentAt` remains the
 *  correct re-anchor point for a delivered mail regardless of the duration. */
export const MAIL_SENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The `expireAt` value to stamp on a `mail/{id}` doc at the moment it's
 * queued (or re-queued into `retry`/left at `error`) — `now` MUST be passed
 * in by the caller rather than resolved here with `Timestamp.now()` whenever
 * the caller already has one in scope (e.g. a `now` shared with the rest of
 * that write), so a parity test comparing two write-builders against the
 * same fake `now` sees identical output. See
 * `__tests__/company/failWritesParity.test.ts` for the concrete case this
 * protects.
 */
export function mailExpireAt(now: Timestamp): Timestamp {
  return Timestamp.fromMillis(now.toMillis() + MAIL_TTL_MS);
}

/** The shorter `expireAt` a mail doc gets rolled forward to once it's
 *  actually been sent — see `MAIL_SENT_TTL_MS`'s docblock. */
export function sentMailExpireAt(now: Timestamp): Timestamp {
  return Timestamp.fromMillis(now.toMillis() + MAIL_SENT_TTL_MS);
}
