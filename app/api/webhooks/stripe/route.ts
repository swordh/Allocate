import { NextRequest, NextResponse, after } from 'next/server'
import Stripe from 'stripe'
import { FieldValue } from 'firebase-admin/firestore'
import { stripe } from '@/lib/stripe'
import { adminDb } from '@/lib/firebase-admin'
import type { SubscriptionStatus } from '@/types/company'
import { PRICE_ID_TO_PLAN, PLAN_LIMITS } from '@/lib/subscription'

export const dynamic = 'force-dynamic'

function mapStripeStatus(stripeStatus: Stripe.Subscription.Status): SubscriptionStatus {
  switch (stripeStatus) {
    case 'trialing':            return 'trialing'
    case 'active':              return 'active'
    case 'incomplete':          return 'incomplete'
    case 'past_due':
    case 'unpaid':
    case 'paused':              return 'past_due'
    case 'canceled':
    case 'incomplete_expired':  return 'canceled'
    default:                    return 'past_due'
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

// #NEW: companyEvents is a top-level collection (see firestore.rules — same
// wildcard-avoidance reasoning as operatorNotes) logging plan/status changes
// going forward. Generic `kind` field so future system events land in one
// indexed collection instead of one collection per event type.
async function logSubscriptionEvent(params: {
  companyId: string
  fromPlan: string | undefined
  toPlan: string
  fromStatus: string | undefined
  toStatus: string
  stripeEventId: string
  stripeSubscriptionId: string
  /**
   * True when `toPlan` was resolved from a Stripe price id with no entry in
   * PRICE_ID_TO_PLAN — the caller already falls back to 'starter' to keep
   * the company document in a valid shape, but that fallback is a guess,
   * not a fact. Writing it as a permanent audit row would record a false
   * claim ("customer downgraded to Starter") that a human will trust and
   * can never be told apart from a real downgrade. A missing row is
   * recoverable (the mirror on the company doc still updated); a false row
   * is not, so the write is suppressed entirely.
   */
  planUnresolved: boolean
}) {
  const { companyId, fromPlan, toPlan, fromStatus, toStatus, stripeEventId, stripeSubscriptionId, planUnresolved } = params

  // Only log when something actually changed. customer.subscription.updated
  // fires for many things (payment method, trial countdown ticks, metadata
  // edits, …) — logging every delivery would turn the feed into noise.
  if (fromPlan === toPlan && fromStatus === toStatus) return

  if (planUnresolved) {
    console.log('[webhooks/stripe]', {
      action: 'subscription_event_suppressed_unresolved_plan',
      companyId,
      stripeSubscriptionId,
    })
    return
  }

  // A trial converting (or any status move with the plan unchanged) is a
  // distinct kind from an actual plan change — "Plan changed basic → basic"
  // would be nonsense copy for a status-only transition.
  const kind = fromPlan === toPlan ? 'status_changed' : 'plan_changed'

  // Deterministic id from the Stripe event id, and `.set()` instead of
  // `.add()`: the `_stripeEvents` dedup ledger below is a read-then-write
  // with no transaction, so a redelivered event can reach this function
  // twice. `.add()` would create two identical rows; `.set()` on the same
  // id collapses a redelivery onto the same document.
  await adminDb.collection('companyEvents').doc(stripeEventId).set({
    companyId,
    kind,
    at: FieldValue.serverTimestamp(),
    fromPlan: fromPlan ?? null,
    toPlan,
    fromStatus: fromStatus ?? null,
    toStatus,
    stripeEventId,
    stripeSubscriptionId,
  })

  console.log('[webhooks/stripe]', {
    action: 'subscription_event_logged',
    kind,
    companyId,
    fromPlan,
    toPlan,
    fromStatus,
    toStatus,
  })
}

// #96: Only writes stripeCustomerId — subscription fields are the sole responsibility
// of handleSubscriptionUpsert (triggered by customer.subscription.created/updated).
async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session) {
  const customerId = session.customer as string | null
  const companyId  = session.metadata?.companyId

  if (!companyId || !customerId) {
    console.error('[webhooks/stripe]', {
      action: 'checkout_session_completed_missing_ids',
      companyId,
      customerId,
    })
    return
  }

  const companyRef = adminDb.doc(`companies/${companyId}`)
  const companySnap = await companyRef.get()
  const existingCustomerId = companySnap.data()?.stripeCustomerId as string | undefined

  if (existingCustomerId && existingCustomerId !== customerId) {
    console.error('[webhooks/stripe]', {
      action: 'checkout_session_customer_id_mismatch',
      companyId,
      existingCustomerId,
      incomingCustomerId: customerId,
    })
    return
  }

  await companyRef.update({ stripeCustomerId: customerId })

  console.log('[webhooks/stripe]', {
    action: 'checkout_session_completed',
    companyId,
    customerId,
  })
}

// #85: Canonical writer for all subscription fields.
// Returns the company snapshot it wrote (so callers don't have to re-fetch
// it — see handleSubscriptionCreated below), or null if the event was
// stale-skipped (#98) or the company could not be found.
async function handleSubscriptionUpsert(
  subscription: Stripe.Subscription,
  eventCreated: number,
  eventId: string,
): Promise<FirebaseFirestore.QueryDocumentSnapshot | null> {
  const customerId = subscription.customer as string
  const companyDoc = await getCompanyDocByCustomerId(customerId)

  if (!companyDoc) {
    console.error('[webhooks/stripe]', {
      action: 'subscription_upsert_company_not_found',
      customerId,
      subscriptionId: subscription.id,
    })
    return null
  }

  const companyId = companyDoc.id

  // #98: Skip stale events — Stripe does not guarantee delivery order
  const storedTs = companyDoc.data()?.subscription?.stripeUpdatedAt ?? 0
  if (eventCreated <= storedTs) {
    console.log('[webhooks/stripe]', {
      action: 'subscription_upsert_stale_skipped',
      companyId,
      subscriptionId: subscription.id,
      eventCreated,
      storedTs,
    })
    return null
  }

  // Captured before the write — this is the "old" side of the plan-change
  // log below. Must happen before `update()`, not after.
  const fromPlan   = companyDoc.data()?.subscription?.plan as string | undefined
  const fromStatus = companyDoc.data()?.subscription?.status as string | undefined

  const mappedStatus = mapStripeStatus(subscription.status)
  const item    = subscription.items.data[0]
  const priceId = item?.price?.id ?? ''
  const planUnresolved = !PRICE_ID_TO_PLAN[priceId]
  const plan    = PRICE_ID_TO_PLAN[priceId] ?? 'starter'
  const limits  = PLAN_LIMITS[plan]

  if (planUnresolved) {
    console.warn('[webhooks/stripe]', {
      action: 'subscription_upsert_unknown_price_id',
      priceId,
      subscriptionId: subscription.id,
    })
  }

  await adminDb.doc(`companies/${companyId}`).update({
    'subscription.status':               mappedStatus,
    'subscription.stripeUpdatedAt':      eventCreated,
    'subscription.stripeSubscriptionId': subscription.id,
    'subscription.plan':                 plan,
    'subscription.limits':               limits,
    'subscription.currentPeriodEnd':     item?.current_period_end
      ? new Date(item.current_period_end * 1000).toISOString()
      : null,
    'subscription.cancelAtPeriodEnd':    subscription.cancel_at_period_end,
    'subscription.trialEnd':             subscription.trial_end
      ? new Date(subscription.trial_end * 1000).toISOString()
      : null,
    'subscription.interval':             item?.plan.interval ?? null,
  })

  console.log('[webhooks/stripe]', {
    action: 'subscription_upsert',
    companyId,
    subscriptionId: subscription.id,
    status: mappedStatus,
  })

  // Logged AFTER the stale-event guard above returns (never before it), so
  // an out-of-order Stripe delivery that gets stale-skipped cannot log a
  // phantom downgrade — only a delivery that actually wrote reaches here.
  // stripeEventId is stored regardless: the `_stripeEvents` dedup ledger is
  // a read-then-write with no transaction, so concurrent redelivery of the
  // same event can still slip past it and call this function twice.
  await logSubscriptionEvent({
    companyId,
    fromPlan,
    toPlan: plan,
    fromStatus,
    toStatus: mappedStatus,
    stripeEventId: eventId,
    stripeSubscriptionId: subscription.id,
    planUnresolved,
  })

  return companyDoc
}

// #118: Wraps upsert for subscription.created events to also set hadTrial.
async function handleSubscriptionCreated(subscription: Stripe.Subscription, eventCreated: number, eventId: string) {
  const companyDoc = await handleSubscriptionUpsert(subscription, eventCreated, eventId)

  if (companyDoc && subscription.status === 'trialing') {
    await adminDb.doc(`companies/${companyDoc.id}`).update({ hadTrial: true })
    console.log('[webhooks/stripe]', {
      action: 'had_trial_set',
      companyId: companyDoc.id,
      subscriptionId: subscription.id,
    })
  }
}

// The Billing Portal's "cancel at period end" flow — and every other path
// that actually ends a subscription — arrives here as
// customer.subscription.deleted, NOT as an `updated` event. This is the
// single most interesting transition an operator watches a feed for, so it
// must log through the same helper as handleSubscriptionUpsert, deriving
// `toStatus` the same way (mapStripeStatus), not a hardcoded string.
async function handleSubscriptionDeleted(subscription: Stripe.Subscription, eventId: string) {
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
  const fromPlan   = companyDoc.data()?.subscription?.plan as string | undefined
  const fromStatus = companyDoc.data()?.subscription?.status as string | undefined
  const toStatus   = mapStripeStatus(subscription.status)

  await adminDb.doc(`companies/${companyId}`).update({
    'subscription.status': toStatus,
  })

  console.log('[webhooks/stripe]', {
    action: 'subscription_deleted',
    companyId,
    subscriptionId: subscription.id,
  })

  // Plan is unchanged by a cancellation — only status moves — and there is
  // no price id to resolve here, so `planUnresolved` is always false.
  await logSubscriptionEvent({
    companyId,
    fromPlan,
    toPlan: fromPlan ?? 'starter',
    fromStatus,
    toStatus,
    stripeEventId: eventId,
    stripeSubscriptionId: subscription.id,
    planUnresolved: false,
  })
}

// #87: Log failed payment attempts for future dunning logic.
async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const invoiceId = invoice.id
  if (!invoiceId) return

  const customerId = invoice.customer as string | null
  const companyDoc = customerId ? await getCompanyDocByCustomerId(customerId) : null

  await adminDb.doc(`stripeFailedPayments/${invoiceId}`).set({
    invoiceId,
    companyId:        companyDoc?.id ?? null,
    customerId,
    amount:           invoice.amount_due,
    currency:         invoice.currency,
    attemptCount:     invoice.attempt_count,
    nextAttempt:      invoice.next_payment_attempt
      ? new Date(invoice.next_payment_attempt * 1000).toISOString()
      : null,
    invoiceCreatedAt: new Date(invoice.created * 1000).toISOString(),
    recordedAt:       new Date().toISOString(),
  })

  console.log('[webhooks/stripe]', {
    action: 'invoice_payment_failed',
    invoiceId,
    companyId:    companyDoc?.id ?? null,
    attemptCount: invoice.attempt_count,
  })
}

// #83: Event processing isolated so errors surface clearly in logs
async function processStripeEvent(event: Stripe.Event) {
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session)
        break

      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object as Stripe.Subscription, event.created, event.id)
        break

      case 'customer.subscription.updated':
        await handleSubscriptionUpsert(event.data.object as Stripe.Subscription, event.created, event.id)
        break

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription, event.id)
        break

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice)
        break

      default:
        console.log('[webhooks/stripe]', { action: 'unhandled_event', type: event.type })
    }
  } catch (err) {
    console.error('[webhooks/stripe]', {
      error: 'Event handler failed',
      type: event.type,
      eventId: event.id,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const signature = request.headers.get('stripe-signature')
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

  // #82: Reject unauthenticated requests — returning 200 would silence Stripe retries
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
    console.error('[webhooks/stripe]', {
      error: 'Signature verification failed',
      message: err instanceof Error ? err.message : String(err),
      code: err instanceof Stripe.errors.StripeError ? err.code : undefined,
    })
    return NextResponse.json({ error: 'Webhook signature verification failed' }, { status: 400 })
  }

  // #84: Deduplicate — Stripe delivers at-least-once; skip already-processed events
  const eventRef = adminDb.doc(`_stripeEvents/${event.id}`)
  const existing = await eventRef.get()
  if (existing.exists) {
    console.log('[webhooks/stripe]', {
      action: 'duplicate_event_skipped',
      eventId: event.id,
      type: event.type,
    })
    return NextResponse.json({ received: true }, { status: 200 })
  }
  await eventRef.set({ processedAt: FieldValue.serverTimestamp(), type: event.type })

  // #97: Return 200 before processing — prevents Vercel timeout on slow Stripe API calls
  after(() => processStripeEvent(event))

  return NextResponse.json({ received: true }, { status: 200 })
}
