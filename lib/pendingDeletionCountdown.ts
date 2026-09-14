const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * The countdown text shown on /no-company for a stranded former member
 * (issue #252 step 5, PR F — design brief "Del 3"). Extracted out of
 * `components/auth/NoCompanyView.tsx` into its own pure module so the exact
 * string this promise is made of — "Nedräkningen ska gå att se, inte bara
 * stå i ett mail hon kanske missade" — can be unit tested without rendering
 * a component: __tests__/lib/pendingDeletionCountdown.test.ts asserts the
 * label text itself, not merely that something renders.
 *
 * Rounds UP (`Math.ceil`) — someone with 12 hours left sees "1 day left",
 * not "0 days left"; only a deadline that has already passed reads "Less
 * than a day left".
 */
export function daysLeftLabel(scheduledForIso: string, now: number = Date.now()): string {
  const msLeft = new Date(scheduledForIso).getTime() - now
  const daysLeft = Math.max(0, Math.ceil(msLeft / MS_PER_DAY))
  if (daysLeft === 0) return 'Less than a day left'
  if (daysLeft === 1) return '1 day left'
  return `${daysLeft} days left`
}
