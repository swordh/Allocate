/**
 * setupStripePortal.ts
 *
 * Idempotent script to create (or update) the Stripe Billing Portal configuration
 * for Allocate's plan-change flow.
 *
 * Run ONCE per Stripe account (once for alpha/beta test mode, once for prod live mode).
 * After running, store the printed configuration ID as STRIPE_PORTAL_CONFIG_ID in
 * .env.local (local dev) and in Google Secret Manager (alpha / beta / prod).
 *
 * Usage (loads .env.local for the target environment):
 *   npx tsx --env-file=.env.local scripts/setupStripePortal.ts
 *
 * Required env vars (set in .env.local or export before running):
 *   STRIPE_SECRET_KEY
 *   STRIPE_PRICE_STARTER_MONTHLY
 *   STRIPE_PRICE_STARTER_YEARLY
 *   STRIPE_PRICE_BASIC_MONTHLY
 *   STRIPE_PRICE_BASIC_YEARLY
 *
 * Optional env vars:
 *   STRIPE_PORTAL_CONFIG_ID  — if set, updates the existing config instead of creating a new one
 *
 * NOTE: In Stripe API version 2026-02-25.clover the `subscription_update.products`
 * allowlist is silently ignored — enabling `subscription_update` makes ALL active
 * prices switchable. The `products` array below is therefore informational; the
 * effective changes this script applies are enabling subscription_update and setting
 * proration_behavior: 'create_prorations'. The TEST default config already has
 * subscription_update enabled (2026-06-05), so createPlanChangeSession works against
 * the dashboard default without STRIPE_PORTAL_CONFIG_ID. Running this is still useful
 * to (re)set proration_behavior idempotently and to configure the LIVE config pre-launch.
 */

import Stripe from 'stripe'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`[setupStripePortal] Missing required env var: ${name}`)
    process.exit(1)
  }
  return value
}

async function main() {
  const stripeSecretKey         = requireEnv('STRIPE_SECRET_KEY')
  const priceStarterMonthly     = requireEnv('STRIPE_PRICE_STARTER_MONTHLY')
  const priceStarterYearly      = requireEnv('STRIPE_PRICE_STARTER_YEARLY')
  const priceBasicMonthly       = requireEnv('STRIPE_PRICE_BASIC_MONTHLY')
  const priceBasicYearly        = requireEnv('STRIPE_PRICE_BASIC_YEARLY')
  const existingConfigId        = process.env.STRIPE_PORTAL_CONFIG_ID

  const stripe = new Stripe(stripeSecretKey, {
    apiVersion: '2026-06-24.dahlia',
    typescript: true,
  })

  // Retrieve each price to get its parent product ID
  console.log('[setupStripePortal] Retrieving prices from Stripe…')
  const [pStarterMonthly, pStarterYearly, pBasicMonthly, pBasicYearly] = await Promise.all([
    stripe.prices.retrieve(priceStarterMonthly),
    stripe.prices.retrieve(priceStarterYearly),
    stripe.prices.retrieve(priceBasicMonthly),
    stripe.prices.retrieve(priceBasicYearly),
  ])

  // Group prices by product, then build the products array
  const byProduct = new Map<string, string[]>()
  for (const price of [pStarterMonthly, pStarterYearly, pBasicMonthly, pBasicYearly]) {
    const productId = typeof price.product === 'string' ? price.product : price.product.id
    const existing  = byProduct.get(productId) ?? []
    existing.push(price.id)
    byProduct.set(productId, existing)
  }

  const products: Stripe.BillingPortal.ConfigurationCreateParams.Features.SubscriptionUpdate.Product[] =
    Array.from(byProduct.entries()).map(([product, prices]) => ({ product, prices }))

  const features: Stripe.BillingPortal.ConfigurationCreateParams.Features = {
    subscription_update: {
      enabled:                  true,
      default_allowed_updates:  ['price'],
      proration_behavior:       'create_prorations',
      products,
    },
    subscription_cancel: {
      enabled:            true,
      mode:               'at_period_end',
      proration_behavior: 'none',
    },
    payment_method_update: {
      enabled: true,
    },
    invoice_history: {
      enabled: true,
    },
    customer_update: {
      enabled:         true,
      allowed_updates: ['email', 'address', 'tax_id'],
    },
  }

  let configuration: Stripe.BillingPortal.Configuration

  if (existingConfigId) {
    console.log(`[setupStripePortal] Updating existing config: ${existingConfigId}`)
    configuration = await stripe.billingPortal.configurations.update(existingConfigId, { features })
  } else {
    console.log('[setupStripePortal] Creating new portal configuration…')
    configuration = await stripe.billingPortal.configurations.create({ features })
  }

  console.log('\n[setupStripePortal] Done.')
  console.log(`Configuration ID: ${configuration.id}`)
  console.log('\nNext step: store this ID as STRIPE_PORTAL_CONFIG_ID in:')
  console.log('  - .env.local (local dev)')
  console.log('  - Google Secret Manager → STRIPE_PORTAL_CONFIG_ID (alpha / beta / prod)')
}

main().catch((err) => {
  console.error('[setupStripePortal] Fatal error:', err)
  process.exit(1)
})
