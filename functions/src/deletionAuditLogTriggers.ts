/**
 * Shared `deletionAuditLog.triggeredBy` values written from inside
 * `functions/src` (issue #252 steps 5 and 6). Exported as named constants,
 * rather than left as a bare string literal re-typed at every write site and
 * every test that asserts on one, so a rename is a compile error instead of
 * a test quietly falling out of sync with the code it's supposed to be
 * checking. Read by `purgeAuditLogs.ts`'s docblock (in prose, not by
 * import — that file never needs to compare against a `triggeredBy` value,
 * only the timestamp field name each row shape carries) and consumed
 * directly by `memberCleanup.ts` and `strandedAccountSweep.ts`, the actual
 * writers.
 *
 * `actions/account.ts`'s `'user_self'` (the fourth `triggeredBy` value that
 * exists in this collection) deliberately stays a bare string literal there
 * rather than importing from here: `actions/` is the root Next.js project's
 * own compilation unit and does not import from `functions/src` anywhere in
 * this codebase — see the boundary notes in
 * functions/src/testSupport/emulatorInit.ts and functions/src/companyStats.ts
 * for why (separate `npm install`, separate module resolution). Pulling in
 * one constant would be a new, one-off cross-boundary dependency; not worth
 * creating for this.
 */

/** `memberCleanup.ts` — a stranded member's account-deletion SCHEDULE (the
 *  purge found her with no other company left), carried on a `scheduledAt` row. */
export const TRIGGERED_BY_STRANDED_MEMBER_SCHEDULED = 'company_deletion_stranded_member';

/** `strandedAccountSweep.ts` — the schedule above being FULFILLED: the
 *  account is actually deleted, carried on a `deletedAt` row. Distinct from
 *  `actions/account.ts`'s `'user_self'` and from
 *  `TRIGGERED_BY_STRANDED_MEMBER_SCHEDULED` — this is the enforcement of an
 *  already-scheduled deletion, not the scheduling of one. */
export const TRIGGERED_BY_STRANDED_ACCOUNT_ENFORCED = 'stranded_account_sweep_enforced';

/** `strandedAccountSweep.ts` — the schedule above being CANCELLED because a
 *  live membership was found when the sweep went to act on it, carried on a
 *  `clearedAt` row (not a deletion event at all). */
export const TRIGGERED_BY_STRANDED_ACCOUNT_SPARED = 'stranded_account_sweep_spared_membership_found';
