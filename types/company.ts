import type Stripe from 'stripe'

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
  /**
   * Mirrors Stripe's `subscription.pause_collection`. Named after Stripe's own
   * field on purpose — NOT `paused`, which is already spoken for twice in this
   * codebase for unrelated things: the webhook maps Stripe's `paused` status to
   * `past_due` (see mapStripeStatus in app/api/webhooks/stripe/route.ts), and
   * __tests__/subscription-state.test.ts locks `'paused'` to `'NONE'`. A future
   * "pending deletion" state derives from this field, never from Stripe's status
   * string — see the #252 step 5 plan.
   */
  pauseCollection?: Stripe.Subscription.PauseCollection['behavior'] | null
  pauseResumesAt?: string | null  // ISO string
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
  memberCount: number             // companies/{id}/members subcollection size
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
