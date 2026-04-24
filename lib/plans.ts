import type { Plan } from '@/types'

export interface PlanConfig {
  name: string
  limits: { equipment: number; users: number }
  monthlyPrice: number
  yearlyPrice: number
}

export const PLANS: Record<Plan, PlanConfig> = {
  basic: {
    name: 'Basic',
    limits: { equipment: 10, users: 3 },
    monthlyPrice: 149,
    yearlyPrice: 1490,
  },
  small: {
    name: 'Small',
    limits: { equipment: 25, users: 10 },
    monthlyPrice: 349,
    yearlyPrice: 3490,
  },
  mid: {
    name: 'Mid',
    limits: { equipment: 60, users: 25 },
    monthlyPrice: 699,
    yearlyPrice: 6990,
  },
  large: {
    name: 'Large',
    limits: { equipment: 150, users: 75 },
    monthlyPrice: 1299,
    yearlyPrice: 12990,
  },
}

export function getPriceId(
  plan: Plan,
  interval: 'month' | 'year',
): string | undefined {
  const key = `STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`
  return process.env[key]
}
