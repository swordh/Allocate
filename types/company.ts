export interface CompanyPreferences {
  bookingTimeSlotMinutes: number
  autoCheckout: boolean
  autoCheckin: boolean
  timezone: string
}

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled'
export type Plan = 'starter'
export type BillingInterval = 'month' | 'year'

export interface Subscription {
  status: SubscriptionStatus
  plan: Plan
  currentPeriodEnd: string        // ISO string
  limits: { equipment: number; users: number }
  trialEnd?: string               // ISO string
  cancelAtPeriodEnd?: boolean
  interval?: BillingInterval
}

export interface Company {
  id: string
  name: string
  createdAt: string               // ISO string
  createdBy: string
  stripeCustomerId: string
  subscription: Subscription
  preferences?: CompanyPreferences
}
