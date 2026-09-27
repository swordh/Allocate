import type { Role } from '@/types'
import type { IconName } from '@/components/ui/Icon'

/**
 * Single source of truth for shell navigation data. Consumed by PrimaryNav,
 * MobileMenu and BookingsSecondaryNav so the three never drift out of sync
 * with each other (they had before this file existed).
 */

export interface TopNavItem {
  label: string
  href: string
  icon: IconName
}

// icon values match the mobile nav sheet's SVGs exactly (the only place
// TOP_NAV.icon is rendered — PrimaryNav's desktop links carry no icon).
export const TOP_NAV: TopNavItem[] = [
  { label: 'BOOKINGS',  href: '/bookings',  icon: 'list' },
  { label: 'EQUIPMENT', href: '/equipment', icon: 'crate' },
  { label: 'SETTINGS',  href: '/settings',  icon: 'settings' },
]

export interface NavItem {
  label: string
  href: string
}

// The operator desktop nav (design_handoff_allocate/screens/operator/*.dc.html,
// header <nav>) carries no icons, and neither does the drawer's nav list —
// so this reuses the plain NavItem shape rather than TopNavItem.
// 'DELETIONS' added for issue #252 step 6 (PR 4) — the two site-wide entry
// points the design brief requires ("hitta alla företag som har en radering
// på gång" / "hitta allt som fastnat eller misslyckats") need a home that
// doesn't presuppose knowing which company to look at, same as CUSTOMERS
// and FEEDBACK. See app/operator/deletions/page.tsx's own docblock for why
// it's one segmented page rather than two.
export const OPERATOR_NAV: NavItem[] = [
  { label: 'CUSTOMERS',  href: '/operator/customers' },
  { label: 'DELETIONS',  href: '/operator/deletions' },
  { label: 'FEEDBACK',   href: '/operator/feedback'  },
]

export const BOOKINGS_ITEMS: NavItem[] = [
  { label: 'List',    href: '/bookings/list' },
  { label: 'Week',    href: '/bookings/week' },
  { label: 'Month',   href: '/bookings/month' },
  { label: '4 Weeks', href: '/bookings/4weeks' },
]

export interface SettingsNavItem extends NavItem {
  /** Roles that see this item. Admin sees all five; everyone else sees Account only. */
  roles: Role[]
  /**
   * Issue #350 (GDPR). Whether this route stays reachable for a company with
   * no active plan — deliberately REQUIRED, not `?:`, so TypeScript forces
   * whoever adds a sixth settings route to make the call rather than
   * silently inheriting `undefined` (which `lib/subscriptionAccess.ts` would
   * then have to treat as "no", hiding the decision instead of surfacing it).
   *
   * Account is `true` because it carries Art. 17/20 (Delete Account, Export
   * my data — `components/settings/AccountSettingsForm.tsx`) and its URL is
   * the one `app/privacy/page.tsx` already publishes as "delete directly
   * from Settings" — a promise that must hold regardless of billing state.
   * Company and Subscription are `true` because they are what an admin needs
   * to get the company OUT of a planless state (see the company's own
   * settings and the Billing Portal link on the subscription page). Team and
   * Preferences are `false` — pure product, no rights and no way out of the
   * gate depend on them.
   */
  alwaysAvailable: boolean
}

const ALL_ROLES: Role[] = ['admin', 'crew']

// Order matches the design: Account, Company, Team, Preferences, Subscription.
export const SETTINGS_ITEMS: SettingsNavItem[] = [
  { label: 'Account',      href: '/settings/account',      roles: ALL_ROLES,    alwaysAvailable: true },
  { label: 'Company',      href: '/settings/company',      roles: ['admin'],    alwaysAvailable: true },
  { label: 'Team',         href: '/settings/team',         roles: ['admin'],    alwaysAvailable: false },
  { label: 'Preferences',  href: '/settings/preferences',  roles: ['admin'],    alwaysAvailable: false },
  { label: 'Subscription', href: '/settings/subscription', roles: ['admin'],    alwaysAvailable: true },
]

/**
 * Replaces the old `settingsItemsForRole` (issue #350) — that function only
 * filtered on role, so a crew/admin tab rail happily offered Team or
 * Preferences to a company with no active plan, and clicking through bounced
 * off `evaluateAppAccess` in `lib/subscriptionAccess.ts`. Filtering on both
 * role AND `alwaysAvailable` here means the tab rail (and the mobile sheet)
 * can never render a tab that the layout guard would then reject — the two
 * are structurally coupled instead of kept in sync by hand. The old function
 * was removed entirely, not deprecated, so no call site can accidentally
 * pick the subscription-blind variant again.
 */
export function settingsItemsFor(role: Role, hasFullAccess: boolean): SettingsNavItem[] {
  return SETTINGS_ITEMS.filter((item) => item.roles.includes(role) && (hasFullAccess || item.alwaysAvailable))
}
