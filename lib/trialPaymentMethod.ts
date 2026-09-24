import 'server-only'

import { stripe } from '@/lib/stripe'
import type { Subscription } from '@/types'

/**
 * Whether Stripe already has a payment method on file for a trialing
 * subscription — checked live on every page load, never stored (see the
 * #252-follow-up plan: no backfill, no new Firestore field). Checkout
 * collects a card at signup (`sub.default_payment_method` is set from the
 * start), so the TRIAL notice's default "add a payment method" copy is
 * wrong for essentially every trialing company; `getSubStateDisplay`
 * (lib/subscription-state.ts) swaps in different copy when this is true.
 *
 * Only makes a Stripe call when `sub.status === 'trialing'` and a
 * `stripeSubscriptionId` is present — every other state returns `false`
 * without touching the network, since the result is never consulted there.
 * A Stripe error also returns `false`: the caller then falls back to the
 * old "add a payment method" text, which is always a safe (if occasionally
 * redundant) thing to ask for.
 */
export async function trialHasPaymentMethod(subscription: Subscription | null): Promise<boolean> {
  if (subscription?.status !== 'trialing' || !subscription.stripeSubscriptionId) return false

  try {
    const sub = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId, {
      expand: ['customer'],
    })

    if (sub.default_payment_method) return true

    const customer = sub.customer
    if (typeof customer === 'string' || customer.deleted) return false

    return Boolean(customer.invoice_settings?.default_payment_method) || Boolean(customer.default_source)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[lib/trialPaymentMethod]', {
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      error: message,
    })
    return false
  }
}
