import type { CompanyDeletion } from '@/types'

/**
 * Client-side mirror of `confirmationMatches` in `actions/companyDeletion.ts`
 * (issue #252 step 6, PR 1). It exists only to enable/disable the confirm
 * button in `CompanySettingsForm` — the server re-checks this exact
 * comparison inside the transaction and is the only copy that counts (see
 * that function's docblock for why a client-side check alone would be
 * "enforced nowhere").
 *
 * Kept in lockstep with the server's rule on purpose: forgive case and
 * surrounding/collapsed whitespace, require everything else verbatim. If the
 * two ever drift, the visible failure is a button that stays disabled on a
 * name the server would have accepted, or one that enables on a name the
 * server rejects — both are worse than duplicating four lines.
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
