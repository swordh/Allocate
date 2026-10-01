/**
 * Filter marker for the Cloud Monitoring log-based alert policies (prod and
 * beta, "Kontoradering fastnad") that fire when a user's `deleteAccount` gets
 * stuck. `recordAccountDeletionFailure` (actions/account.ts) logs it as a
 * plain single-line string after its trace-write transaction commits, and
 * the policies match on
 * `textPayload:"ACCOUNT_DELETION_STUCK" OR jsonPayload.message:"ACCOUNT_DELETION_STUCK"`.
 *
 * The `textPayload` half is the one that actually matches, and must stay:
 * the structured console (instrumentation.ts, lib/structuredLog.ts) turns
 * the string into `{"severity":"ERROR","message":"…"}`, and Cloud Logging
 * stores an entry whose only field is `message` as `textPayload`, not
 * `jsonPayload` (verified on alpha). The `jsonPayload.message` half only
 * matters if the marker is ever logged alongside object fields.
 *
 * Keep the log a plain string, and don't rename this constant or change its
 * value without updating both policies — either one silently breaks the
 * alert with no local signal anything is wrong.
 *
 * Lives here rather than as an export on actions/account.ts: that file has
 * `'use server'` at the top, and a `'use server'` module may only export
 * async Server Actions — a plain string constant export would fail the
 * Next.js build (same reason helper constants/functions needing their own
 * test coverage already live in lib/ rather than being exported from that
 * file — see e.g. lib/queries/deletionOutcomes.ts, lib/companyStats.ts).
 */
export const ACCOUNT_DELETION_STUCK_LOG_MARKER = 'ACCOUNT_DELETION_STUCK'
