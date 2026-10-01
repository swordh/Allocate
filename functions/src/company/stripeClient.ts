import Stripe from 'stripe';

/**
 * Lazy Stripe client for the purge's Stripe phase. Mirrors the lazy-proxy
 * pattern in lib/stripe.ts (root) on purpose — instantiating eagerly at
 * module load would throw as soon as this file is imported by any Cloud
 * Function, including ones that never touch Stripe, if STRIPE_SECRET_KEY
 * happens to be unset (e.g. in the emulator suite, which never configures
 * it). Not imported from lib/stripe.ts directly: functions/ compiles as its
 * own project with no path alias back to the repo root, same boundary
 * documented in functions/src/companyStats.ts and acceptInvitation.ts.
 *
 * `apiVersion` intentionally does NOT try to match lib/stripe.ts's pinned
 * string — functions/ has its own `stripe` npm install
 * (functions/package.json), resolved independently of the root
 * package.json's, and the SDK's TypeScript types only accept the exact
 * version string bundled with that particular install. Same account,
 * same Dashboard-configured default API version either way; only the two
 * *clients'* pinned strings can drift, and each is typechecked against its
 * own install so a mismatch would fail to compile rather than fail silently
 * at runtime.
 */
let cached: Stripe | undefined;

export function getStripeClient(secretKey: string): Stripe {
  if (!cached) {
    cached = new Stripe(secretKey, {
      apiVersion: '2026-08-26.dahlia',
      typescript: true,
    });
  }
  return cached;
}

/** Test-only: forces the next getStripeClient() call to construct a fresh client. */
export function resetStripeClientForTests(): void {
  cached = undefined;
}
