import type { Timestamp } from 'firebase-admin/firestore';
import { appUrl } from '../appUrl';
import type { CompanyDeletionRequestSource } from '../types';

/**
 * e.g. "12 September 2026" — matches the example dates in the mail template
 * docblocks.
 *
 * `timeZone` is REQUIRED, deliberately — issue #361. This used to be
 * `ts.toDate().toLocaleDateString(...)` with no zone, which renders in
 * whatever zone the Cloud Functions runtime happens to run in (UTC, but by
 * accident, not by design — nothing here ever chose that). Every caller must
 * now pass the COMPANY's zone explicitly (`ledger.timezone`, snapshotted at
 * request time — see the doc comment on that field in types/company.ts), so
 * this mail and `formatDateFullInZone` (lib/dates.ts, used by the banner and
 * the cancel page) can never disagree about what date the same instant is.
 * Mirrors `formatDateFullInZone`'s own UTC fallback for an invalid/unknown
 * zone — never let a bad zone string take mail sending down.
 */
export function formatDateFull(ts: Timestamp, timeZone: string): string {
  const d = ts.toDate();
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  }
}

/**
 * e.g. "19 Sep" — for the mail hero/eyebrow, per
 * `CompanyDeletionRequestedData`'s `scheduledForShort`. Same `timeZone`
 * contract as `formatDateFull` above — see its docblock.
 */
export function formatDateShort(ts: Timestamp, timeZone: string): string {
  const d = ts.toDate();
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(d);
  }
}

export function buildCancelUrl(token: string): string {
  return appUrl(`/company-deletion/cancel/${token}`);
}

/**
 * Maps `(requestSource, requestedByName)` to what a CUSTOMER should see as
 * "who asked for this" (issue #334) — the functions-side twin of
 * `formatDeletionRequester` in lib/companyDeletionUi.ts. Deliberately
 * duplicated, not shared, for the same reason `formatDateFull` above is
 * duplicated in lib/companyDeletionCancelWrites.ts: functions/ compiles as
 * its own project with no path alias back to lib/.
 *
 * `'operator'` — support acted on the customer's behalf
 *   (`requestCompanyDeletionAsOperator`, actions/operatorCompanyDeletion.ts).
 *   `requestedByName` on the ledger is the operator's own email — an honest
 *   audit trail, but not something a customer should ever see (issue #334's
 *   whole premise: an admin seeing an unrecognised address in a deletion
 *   mail reads as "someone I don't know is deleting my company"). Renders
 *   the fixed, recognisable string instead.
 * anything else (including absent, i.e. legacy rows before this field
 *   existed) — the ordinary customer-initiated path. Renders
 *   `requestedByName`, falling back to "An administrator" for `null`
 *   (the 24-month identity-redaction case) — this is the EXACT fallback
 *   `onDeletionCreated.ts`/`purge.ts` already used inline before this
 *   helper existed; preserved verbatim, not changed.
 */
/**
 * The one fixed string EVERY customer-facing surface shows in place of an
 * operator's own identity — mirrors `ALLOCATE_SUPPORT_DISPLAY` in
 * lib/companyDeletionUi.ts. Exported for the same reason: a caller that
 * already knows unconditionally "this was the operator" (no
 * `requestSource`/`cancelSource`-shaped mapping to do) reuses this constant
 * rather than a second copy of the literal.
 */
export const ALLOCATE_SUPPORT_DISPLAY = 'Allocate support (support@allocate.at)';

export function formatRequesterDisplay(
  requestSource: CompanyDeletionRequestSource | undefined,
  requestedByName: string | null,
): string {
  if (requestSource === 'operator') return ALLOCATE_SUPPORT_DISPLAY;
  return requestedByName ?? 'An administrator';
}
