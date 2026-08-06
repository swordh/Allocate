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

export const BOOKINGS_ITEMS: NavItem[] = [
  { label: 'List',    href: '/bookings/list' },
  { label: 'Week',    href: '/bookings/week' },
  { label: 'Month',   href: '/bookings/month' },
  { label: '4 Weeks', href: '/bookings/4weeks' },
]

export interface SettingsNavItem extends NavItem {
  /** Roles that see this item. Admin sees all five; everyone else sees Account only. */
  roles: Role[]
}

const ALL_ROLES: Role[] = ['admin', 'crew', 'viewer']

// Order matches the design: Account, Company, Team, Preferences, Subscription.
export const SETTINGS_ITEMS: SettingsNavItem[] = [
  { label: 'Account',      href: '/settings/account',      roles: ALL_ROLES },
  { label: 'Company',      href: '/settings/company',      roles: ['admin'] },
  { label: 'Team',         href: '/settings/team',         roles: ['admin'] },
  { label: 'Preferences',  href: '/settings/preferences',  roles: ['admin'] },
  { label: 'Subscription', href: '/settings/subscription', roles: ['admin'] },
]

export function settingsItemsForRole(role: Role): SettingsNavItem[] {
  return SETTINGS_ITEMS.filter((item) => item.roles.includes(role))
}
