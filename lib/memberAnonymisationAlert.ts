/**
 * Filter marker for the Cloud Monitoring log-based alert policies (all four
 * environments — issue #419) that fire when `anonymizeMemberReferences`
 * (actions/team.ts) can't be made to succeed for a removed/leaving member
 * after a retry. `anonymizeMemberReferencesWithRetry` logs it as a plain
 * single-line string once the second attempt has also failed, and the
 * policies match on
 * `textPayload:"MEMBER_ANONYMISATION_STUCK" OR jsonPayload.message:"MEMBER_ANONYMISATION_STUCK"`.
 *
 * Same reasoning as `lib/accountDeletionAlert.ts`'s marker: the
 * `textPayload` half is the one that actually matches — the structured
 * console (instrumentation.ts, lib/structuredLog.ts) turns the string into
 * `{"severity":"ERROR","message":"…"}`, and Cloud Logging stores an entry
 * whose only field is `message` as `textPayload`, not `jsonPayload`. The
 * `jsonPayload.message` half only matters if the marker is ever logged
 * alongside object fields.
 *
 * Keep the log a plain string, and don't rename this constant or change its
 * value without updating all four policies — either one silently breaks the
 * alert with no local signal anything is wrong.
 *
 * Lives here rather than as an export on actions/team.ts: that file has
 * `'use server'` at the top, and a `'use server'` module may only export
 * async Server Actions — a plain string constant export would fail the
 * Next.js build. Same pattern as `lib/accountDeletionAlert.ts`.
 */
export const MEMBER_ANONYMISATION_STUCK_LOG_MARKER = 'MEMBER_ANONYMISATION_STUCK'
