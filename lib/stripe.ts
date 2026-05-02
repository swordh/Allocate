import 'server-only'

import Stripe from 'stripe'

// Lazy proxy so importing this module never instantiates the Stripe SDK.
// The secret is RUNTIME-only; eager init would throw during Next.js build's
// "Collecting page data" phase (e.g. /api/webhooks/stripe).
function lazy<T extends object>(factory: () => T): T {
  let instance: T | undefined
  const resolve = (): T => {
    if (!instance) instance = factory()
    return instance
  }
  return new Proxy({} as T, {
    get(_target, prop, receiver) {
      const target = resolve()
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export const stripe: Stripe = lazy(() => {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY
  if (!stripeSecretKey) {
    throw new Error('[stripe] STRIPE_SECRET_KEY is not set')
  }
  return new Stripe(stripeSecretKey, {
    apiVersion: '2026-02-25.clover',
    typescript: true,
  })
})
