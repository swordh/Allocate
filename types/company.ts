export interface CompanyPreferences {
  bookingTimeSlotMinutes: number
  autoCheckout: boolean
  autoCheckin: boolean
  timezone: string
}

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'incomplete' | 'canceled'
export type Plan = 'starter' | 'basic'
export type BillingInterval = 'month' | 'year'

export interface Subscription {
  status: SubscriptionStatus
  plan: Plan
  stripeSubscriptionId?: string
  currentPeriodEnd: string        // ISO string
  limits: { equipment: number; users: number }
  trialEnd?: string               // ISO string
  cancelAtPeriodEnd?: boolean
  interval?: BillingInterval
}

/**
 * Derived counters mirrored onto the company document so the operator customer
 * list can filter and sort without querying each company's subcollections.
 * Absent on companies created before the mirror existed — read defensively until
 * tools/backfill_company_stats.js has run everywhere.
 */
export interface CompanyStats {
  equipmentCount: number          // active equipment only
  bookingsCreated: number         // lifetime, never decremented
  bookingsCancelled: number       // lifetime, never decremented
  lastBookingAt: string | null    // ISO string
  updatedAt: string               // ISO string
}

export interface Company {
  id: string
  name: string
  createdAt: string               // ISO string
  createdBy: string
  stripeCustomerId: string
  subscription: Subscription
  preferences?: CompanyPreferences
  stats?: CompanyStats
}
