/**
 * setupStripeLive.ts
 *
 * Idempotent, per-account setup for one Allocate environment's Stripe account.
 * Creates (or reuses) Products, Prices, the webhook endpoint and the Billing
 * Portal configuration, then writes the resulting values into that environment's
 * Google Secret Manager.
 *
 * Designed for LIVE-mode setup of beta and prod (each on its OWN Stripe account),
 * but works for any account/mode. Run it ONCE per Stripe account, in YOUR own
 * terminal, so the secret key never leaves your machine.
 *
 * Usage:
 *   # 1) Preview (no writes anywhere):
 *   STRIPE_SECRET_KEY=sk_live_xxx GCP_PROJECT=allocate-beta \
 *     APP_URL=https://beta.allocate.at \
 *     npx tsx scripts/setupStripeLive.ts
 *
 *   # 2) Apply (creates Stripe resources + writes Secret Manager versions):
 *   STRIPE_SECRET_KEY=sk_live_xxx GCP_PROJECT=allocate-beta \
 *     APP_URL=https://beta.allocate.at APPLY=yes \
 *     npx tsx scripts/setupStripeLive.ts
 *
 * Required env:
 *   STRIPE_SECRET_KEY  live (sk_live_…) or test (sk_test_…) secret key
 *   GCP_PROJECT        target Firebase/GCP project (e.g. allocate-beta, allocate-e0735)
 *   APP_URL            canonical https base URL; webhook = APP_URL + /api/webhooks/stripe
 *
 * Optional env:
 *   CURRENCY           ISO currency, default 'sek'
 *   APPLY              'yes' to perform writes; anything else = dry run
 *
 * Prerequisites: the Stripe account must be ACTIVATED for the chosen mode
 * (live payments require business + bank verification in the Stripe Dashboard),
 * and you must be authenticated to GCP (`gcloud auth login`) with rights to write
 * secrets in GCP_PROJECT.
 *
 * NOTE: A webhook signing secret (whsec_…) is only returned by Stripe when the
 * endpoint is CREATED. If an endpoint for APP_URL already exists, this script
 * cannot read its secret back — it will tell you to either keep the existing
 * STRIPE_WEBHOOK_SECRET in Secret Manager or roll the secret in the Dashboard.
 */

import Stripe from 'stripe'
import { execFileSync } from 'node:child_process'

// ── Plan catalogue (amounts in MINOR units; SEK öre). Mirrors lib/plans.ts. ──
const CURRENCY = process.env.CURRENCY ?? 'sek'
const PLANS = {
  starter: { name: 'Starter', month: 14900, year: 149000 },
  basic:   { name: 'Basic',   month: 39000, year: 390000 },
} as const
type PlanId = keyof typeof PLANS
type Interval = 'month' | 'year'

const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
]

// Secret env var name -> price lookup_key, for Secret Manager writes.
const PRICE_SECRET_BY_KEY: Record<string, { plan: PlanId; interval: Interval }> = {
  STRIPE_PRICE_STARTER_MONTHLY: { plan: 'starter', interval: 'month' },
  STRIPE_PRICE_STARTER_YEARLY:  { plan: 'starter', interval: 'year' },
  STRIPE_PRICE_BASIC_MONTHLY:   { plan: 'basic',   interval: 'month' },
  STRIPE_PRICE_BASIC_YEARLY:    { plan: 'basic',   interval: 'year' },
}

function req(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`[setupStripeLive] Missing required env: ${name}`); process.exit(1) }
  return v
}

function lookupKey(plan: PlanId, interval: Interval): string {
  return `allocate_${plan}_${interval}`
}

async function main() {
  const secretKey  = req('STRIPE_SECRET_KEY')
  const gcpProject = req('GCP_PROJECT')
  const appUrl     = req('APP_URL').replace(/\/+$/, '')
  const apply      = process.env.APPLY === 'yes'

  if (!appUrl.startsWith('https://')) {
    console.error('[setupStripeLive] APP_URL must be https://'); process.exit(1)
  }
  const mode = secretKey.startsWith('sk_live_') ? 'LIVE' : secretKey.startsWith('sk_test_') ? 'TEST' : 'UNKNOWN'
  const webhookUrl = `${appUrl}/api/webhooks/stripe`

  console.log('────────────────────────────────────────────────────')
  console.log(`[setupStripeLive] mode=${mode}  project=${gcpProject}  apply=${apply}`)
  console.log(`[setupStripeLive] webhook=${webhookUrl}  currency=${CURRENCY}`)
  console.log('────────────────────────────────────────────────────')
  if (!apply) console.log('DRY RUN — no Stripe resources created, no secrets written. Set APPLY=yes to execute.\n')

  const stripe = new Stripe(secretKey, { apiVersion: '2026-02-25.clover', typescript: true })

  // ── 1. Products ────────────────────────────────────────────────────────────
  const productIdByPlan: Record<PlanId, string> = { starter: '', basic: '' }
  for (const plan of Object.keys(PLANS) as PlanId[]) {
    const found = await stripe.products.search({ query: `metadata['allocate_plan']:'${plan}'`, limit: 1 })
    if (found.data[0]) {
      productIdByPlan[plan] = found.data[0].id
      console.log(`product ${plan}: reuse ${found.data[0].id}`)
    } else if (apply) {
      const p = await stripe.products.create({ name: `Allocate ${PLANS[plan].name}`, metadata: { allocate_plan: plan } })
      productIdByPlan[plan] = p.id
      console.log(`product ${plan}: created ${p.id}`)
    } else {
      console.log(`product ${plan}: WOULD create`)
    }
  }

  // ── 2. Prices (idempotent by lookup_key) ─────────────────────────────────────
  const priceIdByKey: Record<string, string> = {}
  for (const [secretName, { plan, interval }] of Object.entries(PRICE_SECRET_BY_KEY)) {
    const lk = lookupKey(plan, interval)
    const existing = await stripe.prices.list({ lookup_keys: [lk], active: true, limit: 1 })
    if (existing.data[0]) {
      priceIdByKey[secretName] = existing.data[0].id
      console.log(`price ${lk}: reuse ${existing.data[0].id}`)
    } else if (apply) {
      const price = await stripe.prices.create({
        product: productIdByPlan[plan],
        currency: CURRENCY,
        unit_amount: PLANS[plan][interval],
        recurring: { interval },
        lookup_key: lk,
        transfer_lookup_key: true,
      })
      priceIdByKey[secretName] = price.id
      console.log(`price ${lk}: created ${price.id} (${PLANS[plan][interval]} ${CURRENCY}/${interval})`)
    } else {
      console.log(`price ${lk}: WOULD create (${PLANS[plan][interval]} ${CURRENCY}/${interval})`)
    }
  }

  // ── 3. Webhook endpoint ──────────────────────────────────────────────────────
  let webhookSecret: string | undefined
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 })
  const existingEp = endpoints.data.find((e) => e.url === webhookUrl)
  if (existingEp) {
    console.log(`webhook: reuse ${existingEp.id} (secret not retrievable via API — keep existing STRIPE_WEBHOOK_SECRET or roll it in the Dashboard)`)
  } else if (apply) {
    const ep = await stripe.webhookEndpoints.create({ url: webhookUrl, enabled_events: WEBHOOK_EVENTS })
    webhookSecret = ep.secret
    console.log(`webhook: created ${ep.id}`)
  } else {
    console.log(`webhook: WOULD create -> ${webhookUrl}`)
  }

  // ── 4. Billing Portal configuration (enable plan switching) ──────────────────
  const portalFeatures: Stripe.BillingPortal.ConfigurationCreateParams.Features = {
    subscription_update: {
      enabled: true,
      default_allowed_updates: ['price'],
      proration_behavior: 'create_prorations',
      // products allowlist is silently ignored in 2026-02-25.clover (all active prices switchable)
      products: (Object.keys(PLANS) as PlanId[]).map((plan) => ({
        product: productIdByPlan[plan],
        prices: (['month', 'year'] as Interval[])
          .map((iv) => priceIdByKey[Object.keys(PRICE_SECRET_BY_KEY).find(
            (k) => PRICE_SECRET_BY_KEY[k].plan === plan && PRICE_SECRET_BY_KEY[k].interval === iv)!])
          .filter(Boolean),
      })).filter((p) => p.prices.length > 0),
    },
    subscription_cancel: { enabled: true, mode: 'at_period_end' },
    payment_method_update: { enabled: true },
    invoice_history: { enabled: true },
    customer_update: { enabled: true, allowed_updates: ['email', 'address', 'tax_id'] },
  }
  const configs = await stripe.billingPortal.configurations.list({ limit: 100 })
  const defaultCfg = configs.data.find((c) => c.is_default)
  if (apply) {
    if (defaultCfg) {
      const c = await stripe.billingPortal.configurations.update(defaultCfg.id, { features: portalFeatures })
      console.log(`portal: updated default config ${c.id} (subscription_update enabled)`)
    } else {
      const c = await stripe.billingPortal.configurations.create({ features: portalFeatures })
      console.log(`portal: created config ${c.id} (is_default=${c.is_default})`)
    }
  } else {
    console.log(`portal: WOULD ${defaultCfg ? `update default ${defaultCfg.id}` : 'create new config'} with subscription_update enabled`)
  }

  // ── 5. Write Secret Manager versions ─────────────────────────────────────────
  const secretsToWrite: Record<string, string> = { STRIPE_SECRET_KEY: secretKey, ...priceIdByKey }
  if (webhookSecret) secretsToWrite.STRIPE_WEBHOOK_SECRET = webhookSecret

  console.log('\nSecret Manager writes:')
  for (const [name, value] of Object.entries(secretsToWrite)) {
    const masked = name.includes('SECRET') || name === 'STRIPE_SECRET_KEY' ? `${value.slice(0, 8)}…` : value
    if (!apply) { console.log(`  WOULD set ${name} = ${masked}`); continue }
    ensureSecretExists(gcpProject, name)
    execFileSync('gcloud', ['secrets', 'versions', 'add', name, `--project=${gcpProject}`, '--data-file=-'],
      { input: value, stdio: ['pipe', 'ignore', 'inherit'] })
    console.log(`  set ${name} = ${masked}`)
  }
  if (apply && !webhookSecret && !existingEp) {
    console.log('  WARNING: webhook just created but no secret captured — re-run or set STRIPE_WEBHOOK_SECRET manually.')
  }
  if (apply && existingEp) {
    console.log('  NOTE: STRIPE_WEBHOOK_SECRET left unchanged (endpoint already existed).')
  }

  console.log('\nDone.')
  if (apply) {
    console.log(`Next: redeploy ${gcpProject} so the new secret versions are picked up`)
    console.log('  (App Hosting resolves secret versions at deploy time — push/redeploy the serving branch).')
  } else {
    console.log('Re-run with APPLY=yes to execute.')
  }
}

function ensureSecretExists(project: string, name: string) {
  try {
    execFileSync('gcloud', ['secrets', 'describe', name, `--project=${project}`], { stdio: 'ignore' })
  } catch {
    execFileSync('gcloud', ['secrets', 'create', name, `--project=${project}`, '--replication-policy=automatic'],
      { stdio: 'inherit' })
    console.log(`  created secret ${name}`)
  }
}

main().catch((err) => { console.error('[setupStripeLive] Fatal:', err); process.exit(1) })
