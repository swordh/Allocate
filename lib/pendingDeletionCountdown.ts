const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * What /no-company can truthfully say about a stranded former member's
 * scheduled account deletion (issue #252 step 5, PR F — design brief
 * "Del 3": "Nedräkningen ska gå att se, inte bara stå i ett mail hon
 * kanske missade").
 *
 * Three states, not two, because two of them are reachable in ordinary
 * operation and neither is a countdown:
 *
 *  - `counting` — a deadline in the future. The ordinary case.
 *  - `passed`   — the deadline has already gone by. This is NOT an unlikely
 *                 edge case: the sweep that actually executes a scheduled
 *                 account deletion is deliberately outside both PR E and
 *                 PR F (see "Hård ordningsregel" in
 *                 plan/det-k-nns-som-att-stateless-conway.md), so from day
 *                 31 until that sweep is built this is the NORMAL state of
 *                 every stranded user. Rendering "Less than a day left"
 *                 forever — which is what this module did before — is a
 *                 sentence that is simply false, on the one screen whose
 *                 entire job is telling her the truth about her account.
 *  - `unknown`  — `scheduledFor` is missing, empty, or unparseable. No
 *                 current writer produces that (memberCleanup.ts writes a
 *                 Firestore Timestamp), but nothing structurally prevents
 *                 it either, and `new Date('').getTime()` is `NaN`, which
 *                 renders as "NaN days left". A guard here plus the one in
 *                 `getUserProfile` (lib/queries/users.ts) means the worst
 *                 case is a countdown that is absent rather than a
 *                 countdown that is nonsense.
 *
 * The strings live here rather than in the component so the exact wording
 * can be asserted at string level in
 * __tests__/lib/pendingDeletionCountdown.test.ts — a wrong word here
 * (singular vs plural, a tense that claims something untrue) is exactly
 * what a render-only test would wave through.
 */
export type PendingDeletionCountdown =
  | { kind: 'unknown' }
  | { kind: 'counting'; label: string; caption: string }
  | { kind: 'passed'; label: string; caption: string }

const COUNTING_CAPTION = 'until your account is deleted'
const PASSED_LABEL     = 'Deletion overdue'
const PASSED_CAPTION   = 'your account passed its scheduled deletion date'

/**
 * Days remaining round UP (`Math.ceil`) — someone with twelve hours left
 * reads "1 day left", never "0 days left". Only a deadline that has
 * actually gone by leaves the counting state at all.
 *
 * @param scheduledForIso ISO string from `UserProfile.pendingDeletion`
 *   (types/user.ts). Anything unparseable — including the empty string
 *   `getUserProfile` normalises a present-but-null field to — yields
 *   `{ kind: 'unknown' }`.
 */
export function pendingDeletionCountdown(
  scheduledForIso: string | null | undefined,
  now: number = Date.now(),
): PendingDeletionCountdown {
  if (!scheduledForIso) return { kind: 'unknown' }

  const deadline = new Date(scheduledForIso).getTime()
  if (!Number.isFinite(deadline)) return { kind: 'unknown' }

  const msLeft = deadline - now
  if (msLeft <= 0) {
    return { kind: 'passed', label: PASSED_LABEL, caption: PASSED_CAPTION }
  }

  const daysLeft = Math.ceil(msLeft / MS_PER_DAY)
  return {
    kind:    'counting',
    label:   daysLeft === 1 ? '1 day left' : `${daysLeft} days left`,
    caption: COUNTING_CAPTION,
  }
}
