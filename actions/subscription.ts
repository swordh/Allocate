'use server'

import { getVerifiedSession } from '@/lib/dal'
import { stripe } from '@/lib/stripe'
import { adminDb } from '@/lib/firebase-admin'

export async function createCheckoutSession(
  interval: 'month' | 'year',
  coupon?: string,
): Promise<{ url: string } | { error: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }
  console.log('[actions/subscription]', { uid: session.uid.slice(0, 8) + '...', action: 'create_checkout_session' })

  const priceId =
    interval === 'month'
      ? process.env.STRIPE_PRICE_STARTER_MONTHLY
      : process.env.STRIPE_PRICE_STARTER_YEARLY

  if (!priceId) return { error: 'Stripe price not configured' }

  try {
    const companyId = session.activeCompanyId
    const companyRef = adminDb.doc(`companies/${companyId}`)
    const companySnap = await companyRef.get()
    const companyData = companySnap.data() ?? {}

    let stripeCustomerId: string = companyData.stripeCustomerId ?? ''

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: session.email,
        metadata: { companyId },
      })
      stripeCustomerId = customer.id
      await companyRef.update({ stripeCustomerId })
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { companyId },
      discounts: coupon ? [{ coupon }] : undefined,
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings/subscription?checkout=success`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings/subscription?checkout=canceled`,
    })

    return { url: checkoutSession.url! }
  } catch {
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
