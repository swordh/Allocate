// Client-safe plan catalog for display (price picker, plan badges).
// Keep limits in sync with PLAN_LIMITS in lib/subscription.ts (server-only).
// Prices are in SEK and mirror the Stripe prices for each plan.

export type PlanId = 'starter' | 'basic'

export interface PlanInfo {
  id: PlanId
  name: string
  priceMonthly: number // SEK
  priceYearly: number  // SEK
  equipment: number
  users: number
  /**
   * Single source of truth for plan feature bullets, read by both the
   * settings subscription view and the standalone /subscribe screen. The
   * two design files disagree on wording ("25 equipment types" / "Custom
   * category fields" vs. "25 pieces of equipment" / "All booking views") —
   * Settings' wording wins (Joakim's call, redesign phase 2 commit 13).
   */
  features: string[]
}

export const PLAN_CATALOG: Record<PlanId, PlanInfo> = {
  starter: {
    id: 'starter', name: 'Starter', priceMonthly: 149, priceYearly: 1490, equipment: 25, users: 10,
    features: ['25 equipment types', '10 users', 'All booking views'],
  },
  basic: {
    id: 'basic', name: 'Basic', priceMonthly: 390, priceYearly: 3900, equipment: 100, users: 30,
    features: ['100 equipment types', '30 users', 'Custom category fields'],
  },
}

// Display order in the plan picker (cheapest first).
export const PLAN_ORDER: PlanId[] = ['starter', 'basic']
