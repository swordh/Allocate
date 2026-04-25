import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { stripe } from '@/lib/stripe'
import { adminDb } from '@/lib/firebase-admin'

export const dynamic = 'force-dynamic'

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

async function getCompanyDocByCustomerId(customerId: string) {
  const snap = await adminDb
    .collection('companies')
    .where('stripeCustomerId', '==', customerId)
    .limit(1)
    .get()

  if (snap.empty) return null
  return snap.docs[0]
}

async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session) {
  const customerId = session.customer as string | null
  const companyId = session.metadata?.companyId

  if (!companyId || !customerId) {
    console.error('[webhooks/stripe]', {
      action: 'checkout_session_completed_missing_ids',
      companyId,
      customerId,
    })
    return
  }

  await adminDb.doc(`companies/${companyId}`).update({
    stripeCustomerId: customerId,
  })

  // Fetch subscription immediately to ensure status is available when user lands on /payment-success
  try {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      limit: 1,
    })
    const subscription = subscriptions.data[0]
    if (subscription) {
      const mappedStatus = mapStripeStatus(subscription.status)
      const item = subscription.items.data[0]
      await adminDb.doc(`companies/${companyId}`).update({
        'subscription.status': mappedStatus,
        'subscription.currentPeriodEnd': item?.current_period_end
          ? new Date(item.current_period_end * 1000).toISOString()
          : null,
        'subscription.cancelAtPeriodEnd': subscription.cancel_at_period_end,
        'subscription.trialEnd': subscription.trial_end
          ? new Date(subscription.trial_end * 1000).toISOString()
          : null,
        'subscription.interval': item?.plan.interval ?? null,
      })
    }
  } catch (err) {
    console.error('[webhooks/stripe]', {
      action: 'checkout_session_completed_subscription_fetch_failed',
      companyId,
      customerId,
      err,
    })
  }

  console.log('[webhooks/stripe]', {
    action: 'checkout_session_completed',
    companyId,
    customerId,
  })
}

async function handleSubscriptionUpsert(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string
  const companyDoc = await getCompanyDocByCustomerId(customerId)

  if (!companyDoc) {
    console.error('[webhooks/stripe]', {
      action: 'subscription_upsert_company_not_found',
      customerId,
      subscriptionId: subscription.id,
    })
    return
  }

  const companyId = companyDoc.id
  const mappedStatus = mapStripeStatus(subscription.status)

  const item = subscription.items.data[0]
  await adminDb.doc(`companies/${companyId}`).update({
    'subscription.status': mappedStatus,
    'subscription.currentPeriodEnd': item?.current_period_end
      ? new Date(item.current_period_end * 1000).toISOString()
      : null,
    'subscription.cancelAtPeriodEnd': subscription.cancel_at_period_end,
    'subscription.trialEnd': subscription.trial_end
      ? new Date(subscription.trial_end * 1000).toISOString()
      : null,
    'subscription.interval': item?.plan.interval ?? null,
  })

  console.log('[webhooks/stripe]', {
    action: 'subscription_upsert',
    companyId,
    subscriptionId: subscription.id,
    status: mappedStatus,
  })
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string
  const companyDoc = await getCompanyDocByCustomerId(customerId)

  if (!companyDoc) {
    console.error('[webhooks/stripe]', {
      action: 'subscription_deleted_company_not_found',
      customerId,
      subscriptionId: subscription.id,
    })
    return
  }

  const companyId = companyDoc.id

  await adminDb.doc(`companies/${companyId}`).update({
    'subscription.status': 'canceled',
  })

  console.log('[webhooks/stripe]', {
    action: 'subscription_deleted',
    companyId,
    subscriptionId: subscription.id,
  })
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const signature = request.headers.get('stripe-signature')
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

  if (!signature || !webhookSecret) {
    console.error('[webhooks/stripe]', {
      error: 'Missing stripe-signature or STRIPE_WEBHOOK_SECRET',
    })
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)
  } catch (err) {
    console.error('[webhooks/stripe]', { error: 'Signature verification failed', err })
    return NextResponse.json({ error: 'Webhook signature verification failed' }, { status: 400 })
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session)
        break

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpsert(event.data.object as Stripe.Subscription)
        break

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription)
        break

      default:
        console.log('[webhooks/stripe]', { action: 'unhandled_event', type: event.type })
    }
  } catch (err) {
    console.error('[webhooks/stripe]', { error: 'Event handler failed', type: event.type, err })
  }

  return NextResponse.json({ received: true }, { status: 200 })
}
