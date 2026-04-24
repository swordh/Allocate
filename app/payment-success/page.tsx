import { redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { adminDb } from '@/lib/firebase-admin'
import { stripe } from '@/lib/stripe'
import type Stripe from 'stripe'

type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled'

function mapStripeStatus(stripeStatus: Stripe.Subscription.Status): SubscriptionStatus {
  switch (stripeStatus) {
    case 'trialing':
      return 'trialing'
    case 'active':
      return 'active'
    case 'past_due':
    case 'unpaid':
    case 'paused':
    case 'incomplete':
      return 'past_due'
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled'
    default:
      return 'past_due'
  }
}

export default async function PaymentSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>
}) {
  const session = await getVerifiedSession()
  const { session_id } = await searchParams

  if (!session_id) redirect('/bookings')

  try {
    const checkoutSession = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription'],
    })

    const subscription = checkoutSession.subscription as Stripe.Subscription | null
    const customerId = checkoutSession.customer as string | null

    if (customerId) {
      const updates: Record<string, unknown> = { stripeCustomerId: customerId }

      if (subscription) {
        const item = subscription.items.data[0]
        updates['subscription.status'] = mapStripeStatus(subscription.status)
        updates['subscription.currentPeriodEnd'] = item?.current_period_end
          ? new Date(item.current_period_end * 1000).toISOString()
          : null
        updates['subscription.cancelAtPeriodEnd'] = subscription.cancel_at_period_end
        updates['subscription.trialEnd'] = subscription.trial_end
          ? new Date(subscription.trial_end * 1000).toISOString()
          : null
        updates['subscription.interval'] = item?.plan.interval ?? null
      }

      await adminDb.doc(`companies/${session.activeCompanyId}`).update(updates)
    }
  } catch (err) {
    console.error('[payment-success] verify_failed', err)
  }

  redirect('/bookings')
}
