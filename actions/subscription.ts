'use server'

import { getVerifiedSession } from '@/lib/dal'
import { stripe } from '@/lib/stripe'
import { adminDb } from '@/lib/firebase-admin'
import Stripe from 'stripe'
import type { Plan } from '@/lib/subscription'

const PRICE_ENV_BY_PLAN: Record<Plan, { month?: string; year?: string }> = {
  starter: {
    month: process.env.STRIPE_PRICE_STARTER_MONTHLY,
    year:  process.env.STRIPE_PRICE_STARTER_YEARLY,
  },
  basic: {
    month: process.env.STRIPE_PRICE_BASIC_MONTHLY,
    year:  process.env.STRIPE_PRICE_BASIC_YEARLY,
  },
}

export async function createCheckoutSession(
  interval: 'month' | 'year',
  plan: Plan = 'starter',
): Promise<{ url: string } | { error: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }
  console.log('[actions/subscription]', { uid: session.uid.slice(0, 8) + '...', action: 'create_checkout_session', plan, interval })

  const priceId = interval === 'month' ? PRICE_ENV_BY_PLAN[plan].month : PRICE_ENV_BY_PLAN[plan].year

  if (!priceId) return { error: 'Stripe price not configured' }

  try {
    const companyId = session.activeCompanyId
    const companyRef = adminDb.doc(`companies/${companyId}`)
    const companySnap = await companyRef.get()
    const companyData = companySnap.data() ?? {}

    let stripeCustomerId: string = companyData.stripeCustomerId ?? ''

    if (!stripeCustomerId) {
      const existing = await stripe.customers.search({
        query: `metadata['companyId']:'${companyId}'`,
        limit: 1,
      })
      if (existing.data.length > 0) {
        stripeCustomerId = existing.data[0].id
        await companyRef.update({ stripeCustomerId })
      } else {
        const customer = await stripe.customers.create(
          { email: session.email, name: companyData.name as string | undefined, metadata: { companyId } },
          { idempotencyKey: `create-customer-${companyId}` },
        )
        stripeCustomerId = customer.id
        await companyRef.update({ stripeCustomerId })
      }
    }

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      customer: stripeCustomerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { companyId },
      allow_promotion_codes: true,
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings/subscription?checkout=canceled`,
      subscription_data: companyData.hadTrial
        ? undefined
        : { trial_period_days: 14 },
      payment_method_collection: 'always',
      // TODO(#91): Requires Stripe Tax activated in Dashboard + Swedish VAT registration before launch
      automatic_tax:             { enabled: true },
      tax_id_collection:         { enabled: true },
      billing_address_collection: 'required',
      customer_update:           { address: 'auto', name: 'auto' },
    }

    try {
      const checkoutSession = await stripe.checkout.sessions.create(
        sessionParams,
        { idempotencyKey: `checkout-${companyId}-${plan}-${interval}-${Math.floor(Date.now() / 60000)}`},
      )
      return { url: checkoutSession.url! }
    } catch (err) {
      if (
        err instanceof Stripe.errors.StripeInvalidRequestError &&
        err.code === 'resource_missing' &&
        err.param === 'customer'
      ) {
        const newCustomer = await stripe.customers.create(
          { email: session.email, name: companyData.name as string | undefined, metadata: { companyId } },
          { idempotencyKey: `create-customer-${companyId}` },
        )
        await companyRef.update({ stripeCustomerId: newCustomer.id })
        const retrySession = await stripe.checkout.sessions.create(
          { ...sessionParams, customer: newCustomer.id },
          { idempotencyKey: `checkout-${companyId}-${plan}-${interval}-${Math.floor(Date.now() / 60000)}`},
        )
        return { url: retrySession.url! }
      }
      throw err
    }
  } catch (err) {
    console.error('[actions/subscription]', {
      action: 'create_checkout_session_error',
      message: err instanceof Error ? err.message : String(err),
      code: err instanceof Stripe.errors.StripeError ? err.code : undefined,
    })
    return { error: 'Could not create checkout session' }
  }
}

export async function createPortalSession(): Promise<{ url: string } | { error: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }
  console.log('[actions/subscription]', { uid: session.uid.slice(0, 8) + '...', action: 'create_portal_session' })

  try {
    const companyId = session.activeCompanyId
    const companySnap = await adminDb.doc(`companies/${companyId}`).get()
    const stripeCustomerId: string = companySnap.data()?.stripeCustomerId ?? ''

    if (!stripeCustomerId) return { error: 'No active subscription found' }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings/subscription`,
    })

    return { url: portalSession.url }
  } catch {
    return { error: 'Could not open subscription portal' }
  }
}
