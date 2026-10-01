'use server'

import { getVerifiedSession } from '@/lib/dal'
import { stripe } from '@/lib/stripe'
import { adminDb } from '@/lib/firebase-admin'
import Stripe from 'stripe'
import type { Plan } from '@/lib/subscription'
import { PLAN_LIMITS } from '@/lib/subscription'
import type { BillingInterval } from '@/types'

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

/**
 * Closes the Stripe Billing Portal while a company deletion is scheduled or
 * running (issue #252 step 5). Returns an error message, or `null` to allow.
 *
 * This is the one and only product surface #252 step 5 takes away, and it is
 * not a product restriction — the design brief promises that the company
 * keeps working for the whole seven days, and it does: bookings, equipment,
 * invitations and every gate are untouched. The portal is different because
 * of what a customer can do inside it. Requesting a deletion pauses
 * collection with `behavior: 'void'`, which is reversible: cancelling the
 * deletion resumes billing on the same plan and period, "as if nothing
 * happened" (lib/companyDeletionStripe.ts). Cancelling the SUBSCRIPTION from
 * inside the portal is not reversible by us — `resumeSubscriptionAfterCancel`
 * can only report `already_canceled` and log it for an operator. So leaving
 * the portal open would let a customer walk through a door we promised we
 * could walk them back out of.
 *
 * Presence of the field is the whole check: a cancelled deletion removes
 * `deletion` entirely (see `CompanyDeletionState` in types/company.ts), so the
 * portal reopens by itself the moment a deletion is stopped. Nothing needs to
 * remember to unlock it.
 *
 * Reads the company document that every caller here has already fetched
 * rather than taking a `companyId` and re-reading it — the guard is not worth
 * an extra Firestore read per portal click.
 *
 * ── WHAT THIS GUARD DOES NOT COVER ────────────────────────────────────────
 *
 * 1. **An already-open portal tab.** This stops new Billing Portal sessions
 *    from being created. It cannot touch a session that was issued a minute
 *    before the deletion was requested — Stripe offers no way to revoke an
 *    outstanding portal session, and polling for one would be wildly
 *    disproportionate to the risk. A customer sitting in that tab can still
 *    cancel the subscription. The consequence is handled rather than
 *    prevented: `resumeSubscriptionAfterCancel`
 *    (lib/companyDeletionStripe.ts) returns `already_canceled` and that lands
 *    on the ledger for a step 6 operator to see and act on. Known and
 *    accepted; do not read this guard as airtight.
 *
 * 2. **Stripe's own `trial_will_end` email.** A trial that lapses during the
 *    seven-day window still triggers Stripe's "your trial ends in three days,
 *    add a card" reminder, which is irrelevant — and mildly alarming — to an
 *    admin whose company is scheduled for deletion. Suppressing it is
 *    deliberately not built here: it would mean either disabling the
 *    Dashboard-level reminder for everyone or reaching into `trial_settings`
 *    per subscription, both of which affect companies that are not being
 *    deleted. Noted so whoever builds step 6's operator/customer surfaces has
 *    it on the table rather than rediscovering it from a support ticket.
 */
function billingPortalDeletionGuard(companyData: FirebaseFirestore.DocumentData | undefined): string | null {
  const deletion = companyData?.deletion as { state?: string } | undefined
  if (!deletion) return null
  // 'requested' is the only state a "stop the deletion first" message is
  // TRUE for — only then does an admin have anything left to stop, and
  // stopping it is what reopens the portal (see this function's own
  // docblock, "presence of the field is the whole check"). 'executing' and
  // 'failed' (issue #331/#335: the mirror can now carry 'failed', not just
  // 'requested'/'executing') both describe a purge that has already started
  // or already stalled — nothing in the product can stop it from here any
  // more, so telling the reader to "stop the deletion first" would send her
  // looking for a control that doesn't exist.
  if (deletion.state === 'requested') {
    return 'Billing cannot be changed while this company is scheduled for deletion. Stop the deletion first, and billing resumes on the same plan.'
  }
  return "Billing can't be changed while this company is being deleted. Contact support if you need a receipt."
}

export async function createCheckoutSession(
  interval: 'month' | 'year',
  plan: Plan = 'starter',
): Promise<{ url: string } | { error: string }> {
  const session = await getVerifiedSession()
  // Issue #350 — no UI can produce this call for a non-admin any more
  // (app/subscribe/page.tsx renders NoPlanNotice, not SubscribePage, for
  // any role but admin), but the action is still directly callable, so the
  // message stays human-readable rather than a bare 'Unauthorized' for
  // whoever ends up looking at it (support, logs, a direct call in dev).
  if (session.role !== 'admin') return { error: 'Only an administrator can change the plan.' }
  console.log('[actions/subscription]', { uid: session.uid.slice(0, 8) + '...', action: 'create_checkout_session', plan, interval })

  const priceId = interval === 'month' ? PRICE_ENV_BY_PLAN[plan].month : PRICE_ENV_BY_PLAN[plan].year

  if (!priceId) return { error: 'Stripe price not configured' }

  try {
    const companyId = session.activeCompanyId
    const companyRef = adminDb.doc(`companies/${companyId}`)
    const companySnap = await companyRef.get()
    const companyData = companySnap.data() ?? {}

    // Checkout is guarded for a narrower reason than the portal above: the
    // brief's "Ingen debitering får ske under de sju dagarna" covers a NEW
    // subscription just as much as a renewal, and a company whose trial lapses
    // mid-window could otherwise be talked into paying for a workspace that is
    // scheduled to disappear. Not refunded either (there is no refund logic in
    // #252 step 5, by decision). Checked before the Stripe customer is created
    // so the guard costs nothing.
    const deletionGuard = billingPortalDeletionGuard(companyData)
    if (deletionGuard) return { error: deletionGuard }

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

    const deletionGuard = billingPortalDeletionGuard(companySnap.data())
    if (deletionGuard) return { error: deletionGuard }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings/subscription`,
    })

    return { url: portalSession.url }
  } catch {
    return { error: 'Could not open subscription portal' }
  }
}

// Opens the Billing Portal deep-linked straight to the subscription-update-
// confirm flow for a specific target price. The design's per-card UPGRADE
// CTA plus the MONTHLY/YEARLY cycle chips imply a concrete (plan, interval)
// target rather than the portal's generic "pick anything" flow, so this
// resolves the target price up front and hands it to Stripe directly. The
// portal applies the change immediately with proration; the
// customer.subscription.updated webhook then syncs plan/limits to Firestore.
export async function createPlanChangeSession(
  plan: Plan,
  interval: BillingInterval,
): Promise<{ url: string } | { error: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }
  console.log('[actions/subscription]', {
    uid: session.uid.slice(0, 8) + '...',
    action: 'create_plan_change_session',
    plan,
    interval,
  })

  const priceId = interval === 'month' ? PRICE_ENV_BY_PLAN[plan].month : PRICE_ENV_BY_PLAN[plan].year
  if (!priceId) return { error: 'Stripe price not configured' }

  try {
    const companyId = session.activeCompanyId
    const companySnap = await adminDb.doc(`companies/${companyId}`).get()
    const companyData = companySnap.data() ?? {}

    const stripeCustomerId: string = companyData.stripeCustomerId ?? ''
    const stripeSubscriptionId: string = companyData.subscription?.stripeSubscriptionId ?? ''

    if (!stripeCustomerId || !stripeSubscriptionId) {
      return { error: 'No active subscription found' }
    }

    // Same guard as createPortalSession — this opens the same portal, just
    // deep-linked to a plan change. A plan switch during a `void` pause is
    // exactly the kind of billing change our resume cannot faithfully undo.
    const deletionGuard = billingPortalDeletionGuard(companyData)
    if (deletionGuard) return { error: deletionGuard }

    // Downgrade guard: nothing stops a plan change today that would strand a
    // company above the target plan's caps. Count current usage and block
    // server-side before the portal ever opens — the portal itself has no
    // idea about equipment/member counts.
    const targetLimits = PLAN_LIMITS[plan]
    // Note: this count relies on deleteAccount removing companies/{cid}/members/{uid}
    // when a user leaves. Before that fix shipped, orphaned member docs could
    // inflate this count and block a legitimate downgrade.
    const [equipmentCounterSnap, membersCountSnap] = await Promise.all([
      adminDb.doc(`companies/${companyId}/_meta/equipmentCount`).get(),
      adminDb.collection(`companies/${companyId}/members`).count().get(),
    ])

    const equipmentCount = (equipmentCounterSnap.data()?.count as number | undefined) ?? 0
    const memberCount = membersCountSnap.data().count

    const excessEquipment = Math.max(0, equipmentCount - targetLimits.equipment)
    const excessUsers = Math.max(0, memberCount - targetLimits.users)

    if (excessEquipment > 0 || excessUsers > 0) {
      const parts: string[] = []
      if (excessEquipment > 0) parts.push(`remove ${excessEquipment} equipment item${excessEquipment === 1 ? '' : 's'}`)
      if (excessUsers > 0) parts.push(`remove ${excessUsers} user${excessUsers === 1 ? '' : 's'}`)
      return { error: `To switch to this plan, ${parts.join(' and ')} first.` }
    }

    // subscription_update_confirm needs the current subscription item id.
    const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId)
    const itemId = subscription.items.data[0]?.id
    if (!itemId) return { error: 'No active subscription found' }

    const params: Stripe.BillingPortal.SessionCreateParams = {
      customer: stripeCustomerId,
      return_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings/subscription`,
      flow_data: {
        type: 'subscription_update_confirm',
        subscription_update_confirm: {
          subscription: stripeSubscriptionId,
          items: [{ id: itemId, price: priceId, quantity: 1 }],
        },
      },
    }

    // Use the dedicated portal configuration (plan switching enabled) when set;
    // otherwise fall back to the Stripe Dashboard default configuration.
    if (process.env.STRIPE_PORTAL_CONFIG_ID) {
      params.configuration = process.env.STRIPE_PORTAL_CONFIG_ID
    }

    const portalSession = await stripe.billingPortal.sessions.create(params)

    return { url: portalSession.url }
  } catch (err) {
    console.error('[actions/subscription]', {
      action: 'create_plan_change_session_error',
      message: err instanceof Error ? err.message : String(err),
      code: err instanceof Stripe.errors.StripeError ? err.code : undefined,
    })
    return { error: 'Could not open plan change portal' }
  }
}
