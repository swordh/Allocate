import 'server-only'

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase-admin'
import { stripe } from '@/lib/stripe'
import type { CompanyBilling } from '@/types'

/**
 * Clears `companies/{companyId}.billing` on the read path, ahead of the
 * weekly `billingEmailReminder` sweep (functions/src/company/billingEmailReminder.ts)
 * that would otherwise be the only thing ever removing it. Stripe has no
 * `customer.updated` webhook wired up, so an admin who fixes the billing
 * email straight in the Billing Portal has no other way to make the
 * "billing email missing" banner go away before next week's sweep runs.
 *
 * Mirrors the sweep's own clear condition for the "email present" case
 * only (not the subscription-status / deletion-state checks the sweep also
 * does — those still belong to the sweep, which runs regardless of anyone
 * loading this page). A Stripe or Firestore error here must not surface to
 * the page: worst case the banner stays up a bit longer and the sweep is
 * the backstop, same posture as `billingEmailReminder` itself.
 */
export async function resolveBillingEmailFlag(
  companyId: string,
  stripeCustomerId: string | undefined,
  billing: CompanyBilling | null | undefined,
): Promise<CompanyBilling | null | undefined> {
  if (!billing?.emailMissingSince || !stripeCustomerId) return billing

  try {
    const customer = await stripe.customers.retrieve(stripeCustomerId)
    if (!customer.deleted && customer.email) {
      await adminDb.doc(`companies/${companyId}`).update({ billing: FieldValue.delete() })
      return null
    }
    return billing
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[lib/billingEmailFlag]', {
      companyId,
      stripeCustomerId,
      error: message,
      action: 'clear_failed',
    })
    return billing
  }
}
