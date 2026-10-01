import type { CompanyDeletion, CompanyDeletionRequestSource } from '@/types'

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
 *
 * Takes `Pick<CompanyDeletion, 'state'>` rather than the full `CompanyDeletion`
 * — only `state` is ever read here — so a caller that has normalized just
 * that one field (e.g. `CompanyDeletionBanner`, which is handed a minimal
 * `{state, scheduledFor}` shape rather than the full mirror) can call this
 * without casting. Widening this back to read a second field is a real
 * change: it should fail to compile at every caller that cannot supply that
 * field, not silently see `undefined` there — do not "fix" a future
 * type error here by widening the parameter back to `CompanyDeletion` instead
 * of fixing the caller.
 */
export function canCancelCompanyDeletionInProduct(
  deletion: Pick<CompanyDeletion, 'state'> | null | undefined,
): boolean {
  return deletion?.state === 'requested'
}

/**
 * The one fixed string EVERY customer-facing surface shows in place of an
 * operator's own identity (issue #334) — requester AND canceller alike, same
 * wording everywhere per the product decision. Exported so a caller that
 * only needs the constant (e.g. `cancelCompanyDeletionAsOperator`, which
 * decides "was this an operator?" itself rather than through
 * `formatDeletionRequester`'s `requestSource` mapping) reuses this instead of
 * a second copy of the literal. Mirrored by `ALLOCATE_SUPPORT_DISPLAY` in
 * functions/src/company/format.ts — same duplication reason as everything
 * else shared between that file and this one.
 */
export const ALLOCATE_SUPPORT_DISPLAY = 'Allocate support (support@allocate.at)'

/**
 * Maps `(requestSource, requestedByName)` to what a CUSTOMER should see as
 * "who asked for this" (issue #334) — the root-side twin of
 * `formatRequesterDisplay` in functions/src/company/format.ts. Deliberately
 * duplicated rather than shared — see that function's own docblock for why
 * (the functions/ project has no path alias back to lib/).
 *
 * Every customer-facing surface that used to render `requestedByName`
 * directly — `CompanySettingsForm`'s danger-zone banner,
 * `lib/subscription-state.ts`'s `DELETION_PENDING` notice, and
 * `lookupCancelToken`/`CancelDeletionView` behind the mailed cancel link —
 * calls this instead, so an operator-initiated request never shows the
 * operator's own email to the customer it was requested for. `'operator'`
 * renders `ALLOCATE_SUPPORT_DISPLAY`; anything else (including a legacy row
 * with no `requestSource` at all) renders `requestedByName`, falling back to
 * "An administrator" for a `null`/empty value — the SAME fallback every one
 * of those surfaces already used inline before this helper existed.
 *
 * `cancelCompanyDeletionAsOperator` (actions/operatorCompanyDeletion.ts)
 * does NOT call this — a cancellation has no `requestSource`-shaped field to
 * branch on, it already knows unconditionally that IT is the operator actor,
 * so it passes `ALLOCATE_SUPPORT_DISPLAY` straight into
 * `finishCancellation`'s `cancelledByName` param instead. The ledger's own
 * `canceledByName`/`canceledByEmail` (written by `applyCancelWrites`, same
 * function) are untouched by this — those stay the operator's real identity,
 * for the audit trail and for the operator-only `DeletionHistoryList.tsx`.
 */
export function formatDeletionRequester(
  requestSource: CompanyDeletionRequestSource | null | undefined,
  requestedByName: string | null | undefined,
): string {
  if (requestSource === 'operator') return ALLOCATE_SUPPORT_DISPLAY
  return requestedByName || 'An administrator'
}
