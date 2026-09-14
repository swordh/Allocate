import 'server-only'

import { adminDb } from '@/lib/firebase-admin'
import { stripe } from '@/lib/stripe'

/**
 * The two Stripe side effects of a company-deletion request's *reversible*
 * half: pause collection when the request is made, resume it if an admin
 * cancels. The irreversible half — cancelling the subscription outright and
 * anonymising the customer — belongs to the purge's Stripe phase
 * (functions/src/company/purge.ts, `runStripePhase`) and is deliberately NOT
 * duplicated here.
 *
 * Kept out of `actions/companyDeletion.ts` for two reasons. A `'use server'`
 * module may only export async functions, so no helper in it can be unit
 * tested on its own; and both cancel paths (`cancelCompanyDeletion` and
 * `cancelCompanyDeletionByToken`) need the resume, so it wants one home
 * anyway.
 *
 * ── Why `behavior: 'void'` and not `keep_as_draft` ──────────────────────────
 * `keep_as_draft` accumulates the invoices that would have been issued
 * during the pause and charges them retroactively when collection resumes.
 * That directly breaks the promise the design brief makes about a cancelled
 * deletion — "Avbryts raderingen ska betalningen återupptas som om inget
 * hänt" — by handing the customer a week's worth of catch-up billing for a
 * deletion they changed their mind about. `void` throws those invoices away
 * instead: a cancelled deletion costs us a few free days, which is the side
 * of that trade we chose (see "Stripe" in the step 5 plan). Do not switch
 * this to `keep_as_draft` for tidier books.
 *
 * ── Why nothing here writes `subscription.pauseCollection` ─────────────────
 * Pausing produces a `customer.subscription.updated` webhook, and
 * `app/api/webhooks/stripe/route.ts` already mirrors `pauseCollection` /
 * `pauseResumesAt` onto the company document — with a `stripeUpdatedAt`
 * stale-guard (PR B) that a direct write from here would not go through.
 * Writing the mirror from both places is how a delayed webhook delivery ends
 * up clobbering a newer state; the mirror has exactly one writer on purpose.
 *
 * ── Why neither function throws ────────────────────────────────────────────
 * A Stripe outage must not be able to prevent an admin from requesting a
 * deletion, or — much worse — from CANCELLING one. Both return a structured
 * outcome that the caller records on the ledger (`recordStripeOutcome`), so
 * a failed pause is visible to an operator in step 6's view rather than
 * silently discovered on the customer's next invoice. That failure mode is
 * named as a known risk in the plan ("Stripe-pausen kan misslyckas medan
 * begäran lyckas"); making it loud on the ledger is the mitigation, not
 * failing the whole request.
 */
export type StripeDeletionEffect =
  /** Collection paused / resumed for real. */
  | 'applied'
  /** The company has no Stripe subscription to act on — nothing to do, not a failure. */
  | 'no_subscription'
  /** Resume only: the subscription is already `canceled` and cannot be resumed. */
  | 'already_canceled'
  /** The Stripe call failed; `error` carries the message. */
  | 'failed'

export interface StripeDeletionOutcome {
  effect: StripeDeletionEffect
  error?: string
}

async function readSubscriptionId(companyId: string): Promise<string | undefined> {
  const snap = await adminDb.doc(`companies/${companyId}`).get()
  return snap.data()?.subscription?.stripeSubscriptionId as string | undefined
}

/**
 * Pauses collection on the company's subscription for the duration of a
 * deletion window. Never throws — see this module's docblock.
 */
export async function pauseSubscriptionForDeletion(companyId: string): Promise<StripeDeletionOutcome> {
  try {
    const subscriptionId = await readSubscriptionId(companyId)
    if (!subscriptionId) return { effect: 'no_subscription' }

    await stripe.subscriptions.update(subscriptionId, {
      pause_collection: { behavior: 'void' },
    })
    console.log('[lib/companyDeletionStripe]', { companyId, action: 'subscription_paused' })
    return { effect: 'applied' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[lib/companyDeletionStripe]', {
      companyId,
      error: message,
      action: 'subscription_pause_failed',
    })
    return { effect: 'failed', error: message }
  }
}

/**
 * Lifts the pause after an admin cancels a deletion.
 *
 * The `canceled` check is the plan's "återupptagning får aldrig kasta om
 * prenumerationen redan är uppsagd". It is checked explicitly BEFORE the
 * update rather than only caught afterwards, because the two cases mean
 * genuinely different things to whoever reads the ledger: `already_canceled`
 * is a subscription that will not come back and the customer has to
 * re-subscribe (an operator has something to tell them), while `failed` is a
 * Stripe error that may well succeed on a retry. Collapsing both into one
 * catch would hide the first behind the second. The surrounding try/catch
 * still covers the race where it gets cancelled between the read and the
 * update.
 */
export async function resumeSubscriptionAfterCancel(companyId: string): Promise<StripeDeletionOutcome> {
  try {
    const subscriptionId = await readSubscriptionId(companyId)
    if (!subscriptionId) return { effect: 'no_subscription' }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId)
    if (subscription.status === 'canceled') {
      console.error('[lib/companyDeletionStripe]', {
        companyId,
        action: 'subscription_resume_skipped_canceled',
      })
      return { effect: 'already_canceled' }
    }

    await stripe.subscriptions.update(subscriptionId, { pause_collection: null })
    console.log('[lib/companyDeletionStripe]', { companyId, action: 'subscription_resumed' })
    return { effect: 'applied' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[lib/companyDeletionStripe]', {
      companyId,
      error: message,
      action: 'subscription_resume_failed',
    })
    return { effect: 'failed', error: message }
  }
}

/**
 * Writes one of the outcomes above onto `companyDeletions/{requestId}` so an
 * operator can see what happened to the money without reading logs. Swallows
 * its own errors: this is bookkeeping about a side effect, and failing the
 * caller's request over a failed ledger annotation would be the tail wagging
 * the dog.
 */
export async function recordStripeOutcome(
  requestId: string,
  field: 'stripePause' | 'stripeResume',
  outcome: StripeDeletionOutcome,
): Promise<void> {
  try {
    await adminDb.doc(`companyDeletions/${requestId}`).update({
      [field]: {
        at: new Date().toISOString(),
        effect: outcome.effect,
        ...(outcome.error ? { error: outcome.error } : {}),
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[lib/companyDeletionStripe]', {
      requestId,
      field,
      error: message,
      action: 'record_stripe_outcome_failed',
    })
  }
}
