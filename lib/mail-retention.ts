import 'server-only'

import { Timestamp } from 'firebase-admin/firestore'

/**
 * Mirror of `MAIL_TTL_MS`/`MAIL_SENT_TTL_MS`/`mailExpireAt`/`sentMailExpireAt`
 * in `functions/src/email/mailRetention.ts` — `functions/` compiles as its
 * own project with no path alias back to the repo root, so this can't be
 * shared by import, only kept in lockstep by hand (same pattern as
 * `lib/roles.ts` ↔ `functions/src/auth/role.ts`).
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
 * A queued mail (still `status: 'queued'` or `'retry'`, or one that reached
 * `'error'`) lives 90 days — long enough to investigate a delivery problem
 * — before TTL reclaims it. `mailDelivery.ts`'s `deliverMail` rolls
 * `expireAt` forward to `sentMailExpireAt` the moment a mail actually reaches
 * `status: 'sent'`, since a delivered mail's recipient address has no reason
 * to outlive it by nearly as long.
 */
export const MAIL_TTL_MS = 90 * 24 * 60 * 60 * 1000

/** How long a `mail/{id}` doc survives once it reaches `status: 'sent'` —
 *  see `MAIL_TTL_MS`'s docblock above for why this is shorter. */
export const MAIL_SENT_TTL_MS = 30 * 24 * 60 * 60 * 1000

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
  return Timestamp.fromMillis(now.toMillis() + MAIL_TTL_MS)
}

/** The shorter `expireAt` a mail doc gets rolled forward to once it's
 *  actually been sent — see `MAIL_SENT_TTL_MS`'s docblock. */
export function sentMailExpireAt(now: Timestamp): Timestamp {
  return Timestamp.fromMillis(now.toMillis() + MAIL_SENT_TTL_MS)
}
