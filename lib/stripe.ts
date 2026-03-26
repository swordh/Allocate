import 'server-only'

import Stripe from 'stripe'

const stripeSecretKey = process.env.STRIPE_SECRET_KEY
if (!stripeSecretKey) {
  throw new Error('[stripe] STRIPE_SECRET_KEY is not set')
}

export const stripe = new Stripe(stripeSecretKey, {
  // Pinned to the latest stable Stripe API version.
  apiVersion: '2025-03-31.basil',
  typescript: true,
})
