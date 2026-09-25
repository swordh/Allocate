/**
 * Filter marker for a Cloud Monitoring log-based alert policy (prod) that
 * fires when a user's `deleteAccount` gets stuck — the policy matches on
 * `textPayload:"ACCOUNT_DELETION_STUCK" OR jsonPayload.message:"ACCOUNT_DELETION_STUCK"`
 * (the second form once server logs are emitted as structured JSON) against
 * the single-line log
 * `recordAccountDeletionFailure` (actions/account.ts) emits after its
 * trace-write transaction commits. That log line MUST stay a single line —
 * Cloud Run/App Hosting splits a multi-line/structured
 * `console.error('[tag]', {obj})` call into one log entry PER LINE (e.g. a
 * lone `"[actions/account] {"` entry with none of the actual fields), which a
 * `textPayload` filter can't match against — and this constant MUST NOT be
 * renamed or have its value changed without updating the alert policy;
 * either one silently breaks the alert with no local signal anything is
 * wrong.
 *
 * Lives here rather than as an export on actions/account.ts: that file has
 * `'use server'` at the top, and a `'use server'` module may only export
 * async Server Actions — a plain string constant export would fail the
 * Next.js build (same reason helper constants/functions needing their own
 * test coverage already live in lib/ rather than being exported from that
 * file — see e.g. lib/queries/deletionOutcomes.ts, lib/companyStats.ts).
 */
export const ACCOUNT_DELETION_STUCK_LOG_MARKER = 'ACCOUNT_DELETION_STUCK'
