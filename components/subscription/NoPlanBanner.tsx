import ErrorBanner from '@/components/ui/ErrorBanner'
import Button from '@/components/ui/Button'
import type { Role } from '@/types'
import styles from './NoPlanBanner.module.css'

interface NoPlanBannerProps {
  hasFullAccess: boolean
  role: Role
  /** Forwarded to the underlying `ErrorBanner` — same reason as `CompanyDeletionBanner`'s `className`: lets the layout give it page spacing without an extra wrapping element that would render even when there is nothing to show. */
  className?: string
}

/**
 * The app-shell "no active plan" notice — issue #350 (GDPR). Rendered by
 * `app/(app)/layout.tsx` beside `CompanyDeletionBanner`, following that
 * component's own pattern: a Server Component with minimal props, styled
 * via `className` from the layout rather than owning its own page margin.
 *
 * Exists because #350's fix makes `/settings/account`, `/settings/company`
 * and `/settings/subscription` reachable for a company with no active plan
 * (see `lib/subscriptionAccess.ts`), but the rest of the app shell —
 * Bookings, Equipment — stays visible in `PrimaryNav`/`MobileMenu` even
 * though those routes will bounce a planless visitor back out. The banner is
 * the "why do Bookings and Equipment not work" explanation the nav shell
 * itself no longer gives (decision: nav links stay, no per-link disabling —
 * banner only).
 *
 * Copy is role-dependent, not just role-blind boilerplate: a non-admin
 * cannot buy a plan (`actions/subscription.ts` rejects `createCheckoutSession`
 * for any role but admin), so sending crew to `/subscribe` would be a
 * dead end — the same reasoning `evaluateAppAccess` already uses to route
 * blocked non-admins to `/settings/account` instead of `/subscribe`. Only
 * the admin copy carries the `/subscribe` link; crew are told to
 * contact their administrator, with no link at all, because there is
 * nothing for them to do at that destination.
 */
export default function NoPlanBanner({ hasFullAccess, role, className }: NoPlanBannerProps) {
  if (hasFullAccess) return null

  const isAdmin = role === 'admin'

  return (
    <ErrorBanner
      tone="danger"
      className={className}
      action={
        isAdmin ? (
          <Button variant="secondary" size="sm" href="/subscribe">
            CHOOSE A PLAN
          </Button>
        ) : undefined
      }
    >
      <span className={styles.lead}>No active plan.</span> Bookings are paused
      {isAdmin ? '.' : ' — contact your administrator.'}
    </ErrorBanner>
  )
}
