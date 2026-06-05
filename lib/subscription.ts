import 'server-only'

export type Plan = 'starter' | 'basic'

export const PLAN_LIMITS: Record<Plan, { equipment: number; users: number }> = {
  starter: { equipment: 25, users: 10 },
  basic:   { equipment: 100, users: 30 },
}

// Maps Stripe price IDs to internal plan names.
// Add new prices here when plans are expanded.
export const PRICE_ID_TO_PLAN: Record<string, Plan> = {
  [process.env.STRIPE_PRICE_STARTER_MONTHLY!]: 'starter',
  [process.env.STRIPE_PRICE_STARTER_YEARLY!]:  'starter',
  [process.env.STRIPE_PRICE_BASIC_MONTHLY!]:   'basic',
  [process.env.STRIPE_PRICE_BASIC_YEARLY!]:    'basic',
}
