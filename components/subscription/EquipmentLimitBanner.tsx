import ErrorBanner from '@/components/ui/ErrorBanner'
import Button from '@/components/ui/Button'
import { shouldShowEquipmentLimitBanner } from '@/lib/equipmentLimitBanner'
import type { Role } from '@/types'
import styles from './NoPlanBanner.module.css'

interface EquipmentLimitBannerProps {
  role: Role
  hasFullAccess: boolean
  /** `_meta/equipmentCount`, or null when the layout skipped the read. */
  count: number | null
  limit: number | undefined
  /** Forwarded to `ErrorBanner` for page spacing — same reason as `NoPlanBanner`. */
  className?: string
}

/**
 * App-shell notice for an admin whose company holds more equipment items than
 * the plan includes (#284). Can only happen to companies that were under the
 * limit when the counter moved from types to items, or that downgraded; the
 * add controls are disabled and the server refuses additions meanwhile.
 * Rendered by `app/(app)/layout.tsx` beside `NoPlanBanner`. Visibility rules
 * live in `lib/equipmentLimitBanner.ts`.
 */
export default function EquipmentLimitBanner({
  role,
  hasFullAccess,
  count,
  limit,
  className,
}: EquipmentLimitBannerProps) {
  if (!shouldShowEquipmentLimitBanner({ role, hasFullAccess, count, limit })) return null

  return (
    <ErrorBanner
      tone="danger"
      className={className}
      action={
        <Button variant="secondary" size="sm" href="/settings/subscription">
          UPGRADE
        </Button>
      }
    >
      <span className={styles.lead}>Over your equipment limit.</span> You have {count} items on a
      plan that includes {limit}.
    </ErrorBanner>
  )
}
