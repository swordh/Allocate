// Issue #350 (GDPR) — subscription/route access guard extracted out of
// `app/(app)/layout.tsx` so it is a pure, testable function instead of logic
// buried in a Server Component. No `server-only` import: `SettingsTabs`
// (components/settings/SettingsTabs.tsx) is a Client Component and needs to
// import `settingsItemsFor`-adjacent decisions from the same place the
// layout uses, same reasoning as the note on `lib/subscription-state.ts`.
//
// `needsSubscription` keeps EXACTLY the signature the old local copy in
// `__tests__/subscription-gating.test.ts` had (issue #71) — that is what
// lets step 8a of the #350 plan become a pure import swap instead of a
// rewrite of 13 already-correct test cases.

import type { Role } from '@/types'
import { SETTINGS_ITEMS } from '@/components/nav/nav-items'

/**
 * True when the company does NOT have full product access and therefore
 * needs to be sent toward `/subscribe` (or, for routes carved out by
 * `evaluateAppAccess`, allowed through anyway). Preserved verbatim from
 * issue #71: `trialEnd` distinguishes a real Stripe trial (webhook-set) from
 * the non-billing auto-trial every company starts with (`trialEnd: null`),
 * which is what closed the "start checkout, abandon it, keep `trialing`
 * forever" hole — see this function's original docblock in the now-retired
 * inline copy for the exploit this guards against.
 */
export function needsSubscription(subStatus: string | undefined, trialEnd: string | null): boolean {
  const isRealTrial = subStatus === 'trialing' && trialEnd !== null
  return subStatus !== 'active' && !isRealTrial
}

/** Inverse of `needsSubscription`, named for readability at call sites that want the positive form. */
export function hasFullAccess(subStatus: string | undefined, trialEnd: string | null): boolean {
  return !needsSubscription(subStatus, trialEnd)
}

export type AppAccessDecision =
  | { allowed: true }
  | { allowed: false; redirectTo: '/subscribe' | '/settings/account' }

/**
 * Whether the given request may proceed under `(app)`, and if not, where it
 * should be sent.
 *
 * Replaces `app/(app)/layout.tsx`'s old status-whitelist
 * (`['past_due','canceled','incomplete']`) with a route-flag lookup against
 * `SETTINGS_ITEMS[].alwaysAvailable`. The whitelist's `else` branch failed
 * closed on every status it didn't recognise — including ones that mean
 * "still no real plan" but aren't in the list, and critically, including
 * `undefined` (no `subscription` field at all, i.e. a company that never
 * started checkout). That fail-closed `else` is exactly what blocked
 * `/settings/account` — the one page that carries Art. 17/20 (Delete
 * Account, Export my data) and the one URL `app/privacy/page.tsx` already
 * promises works "directly from Settings". Flipping the check from "is this
 * status on a list of statuses we remembered to add" to "is this route
 * flagged always-available" means a future, unmapped Stripe status can never
 * silently re-close that door — the routes that must stay open are declared
 * once, in `SETTINGS_ITEMS`, not re-derived here from billing state.
 *
 * Path matching is exact-or-segment (`p === href || p.startsWith(href +
 * '/')`), never a bare `startsWith(href)`. A bare prefix match would let
 * `/settings/accountant` piggyback on `/settings/account`'s allowance — an
 * unrelated route reachable only because it happens to share a string
 * prefix. The segment arm is intentional, not just the exact-match arm: it
 * means a future `/settings/account/export` sub-route inherits the
 * allowance automatically instead of becoming a silent GDPR regression the
 * day someone adds it and forgets this file exists.
 *
 * An empty or `null` pathname fails closed. `x-pathname` is set by the proxy
 * (see `app/(app)/layout.tsx`'s call site); if it's ever missing — a header
 * the infra layer forgot to forward, say — treating that as "assume it's a
 * safe route" would be exactly the kind of silent regression this function
 * exists to prevent. Losing settings access when the header itself is broken
 * is a visible, debuggable failure; silently granting full access when we
 * don't know the path is not. Failing closed still respects the role split,
 * though: we don't know the path, but we do know the role, so a non-admin
 * still lands on `/settings/account`, never `/subscribe` — the same
 * `role === 'admin' ? '/subscribe' : '/settings/account'` used everywhere
 * else in this function. Not knowing the destination is not a license to
 * send a member somewhere she can't act on either.
 *
 * Role matching here is a convenience, not the authority: each settings page
 * already redirects a role that shouldn't be there, so a bad role match
 * here degrades to "the page will fix it," not an actual authorization
 * bypass. Account is reachable by all three roles, so this can't loop.
 *
 * Non-admin without full access lands on `/settings/account`, never
 * `/subscribe` — a crew member cannot buy a plan, so sending them to
 * a page whose only action is "choose a plan" is a dead end. Admin without
 * full access goes to `/subscribe`, since only an admin can act on it.
 */
export function evaluateAppAccess(input: {
  pathname: string | null | undefined
  role: Role
  subStatus: string | undefined
  trialEnd: string | null
}): AppAccessDecision {
  const { role, subStatus, trialEnd } = input

  if (hasFullAccess(subStatus, trialEnd)) return { allowed: true }

  if (!input.pathname) return { allowed: false, redirectTo: role === 'admin' ? '/subscribe' : '/settings/account' }

  // Strip a single trailing slash so '/settings/account/' matches the same
  // as '/settings/account' — Next never hands us a pathname like this, but
  // normalizing costs nothing and removes a class of near-miss bugs.
  const pathname = input.pathname.length > 1 && input.pathname.endsWith('/')
    ? input.pathname.slice(0, -1)
    : input.pathname

  // Bare '/settings' is a pass-through page (app/(app)/settings/page.tsx)
  // that immediately redirects somewhere always-available — never a
  // destination in its own right, so it can't be blocked here.
  if (pathname === '/settings') return { allowed: true }

  const reachable = SETTINGS_ITEMS.some(
    (item) => item.alwaysAvailable && (pathname === item.href || pathname.startsWith(item.href + '/')),
  )

  if (!reachable) {
    return { allowed: false, redirectTo: role === 'admin' ? '/subscribe' : '/settings/account' }
  }

  const roleAllowed = SETTINGS_ITEMS.some(
    (item) =>
      item.alwaysAvailable &&
      item.roles.includes(role) &&
      (pathname === item.href || pathname.startsWith(item.href + '/')),
  )

  if (!roleAllowed) return { allowed: false, redirectTo: '/settings/account' }

  return { allowed: true }
}
