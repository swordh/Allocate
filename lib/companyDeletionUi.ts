import type { CompanyDeletion } from '@/types'

/**
 * Whether a typed confirmation counts as "the admin confirmed deleting this
 * company" (issue #252 step 6). The brief requires "en medveten handling,
 * inte bara ett klick", and asking the admin to type the company's name is
 * that handling — but only where it is actually enforced.
 *
 * This function is called from two places, and only one of them counts:
 * `requestCompanyDeletion` (actions/companyDeletion.ts) calls it inside its
 * transaction, and that is the check that matters. Every server action in
 * this codebase is a public endpoint to anyone holding a session cookie (see
 * the CRITICAL note in proxy.ts: actions are not routes and the middleware
 * never sees them), so a confirmation enforced only in a React component
 * would be enforced nowhere. `CompanySettingsForm` also calls it, but only to
 * enable/disable its confirm button — a convenience so the button doesn't
 * light up on text the server is certain to reject, not a gate of its own.
 *
 * Case and surrounding whitespace are forgiven, interior wording is not: an
 * admin who types "rigg & rep ab" plainly meant the company called "Rigg &
 * Rep AB", and refusing that teaches people to paste rather than read. What
 * is NOT forgiven is a different name, an empty string, or the literal word
 * "DELETE" — the point of the ritual is that you have to have looked at
 * which company you are on.
 */
export function confirmationMatchesCompanyName(input: string, companyName: string): boolean {
  const normalize = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
  const normalizedName = normalize(companyName)
  if (normalizedName.length === 0) return false
  return normalize(input) === normalizedName
}

/**
 * Whether a pending company deletion can be cancelled from the in-product
 * cancel button — i.e. whether `cancelCompanyDeletion()` (actions/
 * companyDeletion.ts) would actually succeed rather than throw `in-progress`.
 *
 * Shared by `CompanySettingsForm` and `SubscriptionView` so the two surfaces
 * can never disagree about whether a "stop it" button is honest to show. The
 * server only accepts a cancel while `deletion.state === 'requested'` — once
 * it flips to `executing` (the sweep has claimed it) or `failed` (a purge
 * attempt needs an operator), the deletion has already started and cannot be
 * stopped from here at all. Offering the button anyway would be a control
 * that is guaranteed to fail; hiding it without saying why would be a control
 * that silently vanished. Neither is "visa det verkliga läget" — the caller
 * is expected to render a real, state-specific message when this is false,
 * not simply omit the button.
 */
export function canCancelCompanyDeletionInProduct(deletion: CompanyDeletion | null | undefined): boolean {
  return deletion?.state === 'requested'
}
