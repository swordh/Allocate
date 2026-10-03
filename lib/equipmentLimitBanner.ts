import type { Role } from '@/types'

interface EquipmentLimitBannerInput {
  role: Role
  /** `hasFullAccess(...)` — false means the company has no active plan. */
  hasFullAccess: boolean
  /** `_meta/equipmentCount`; null when it was not read. */
  count: number | null
  /** `subscription.limits.equipment`. */
  limit: number | undefined
}

/**
 * Whether the app shell shows the "over your equipment limit" banner (#284).
 *
 * Admins only: only they can upgrade. Strictly over the limit — sitting exactly
 * on it is allowed and says nothing. Not without an active plan, because
 * NoPlanBanner already explains that state and the limit means nothing then.
 *
 * Also the gate for the read itself: the layout asks for the counter only when
 * `shouldReadEquipmentCount` is true, so crew and planless companies cost nothing.
 */
export function shouldReadEquipmentCount(role: Role, hasFullAccess: boolean): boolean {
  return role === 'admin' && hasFullAccess
}

export function shouldShowEquipmentLimitBanner({
  role,
  hasFullAccess,
  count,
  limit,
}: EquipmentLimitBannerInput): boolean {
  if (!shouldReadEquipmentCount(role, hasFullAccess)) return false
  if (count === null || limit === undefined) return false
  return count > limit
}
