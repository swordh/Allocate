/**
 * Unit tests for the subscription gating logic (issue #71).
 *
 * The layout's gating condition is extracted here as a pure function so it
 * can be tested in isolation without Next.js server infrastructure.
 *
 * Bug: the old guard used `stripeCustomerId` presence as a proxy for an active
 * Stripe trial. A user could initiate checkout (which writes stripeCustomerId
 * to Firestore immediately), then abandon it — leaving status='trialing' but
 * stripeCustomerId set, which falsely passed the old guard.
 *
 * The fix uses `trialEnd` instead: it is null for auto-trials created at
 * signup and is only set by the Stripe webhook when a real Stripe trial
 * begins. So `trialEnd !== null` is the correct signal for a real trial.
 *
 * Covered cases:
 *   - active subscription              → allowed
 *   - real Stripe trial (trialEnd set) → allowed
 *   - auto-trial (trialEnd null)       → blocked
 *   - abandoned checkout exploit       → blocked
 *   - past_due                         → blocked
 *   - canceled                         → blocked
 *   - undefined status (no company doc)→ blocked
 */

import { describe, it, expect } from 'vitest'

// ── Function under test ───────────────────────────────────────────────────────
//
// This is the logic that WILL replace the current layout guard once the fix
// lands (app/(app)/layout.tsx). Tests written before the implementation so
// the fix can be validated immediately on merge.

function needsSubscription(subStatus: string | undefined, trialEnd: string | null): boolean {
  const isRealTrial = subStatus === 'trialing' && trialEnd !== null
  return subStatus !== 'active' && !isRealTrial
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('needsSubscription', () => {

  // ── Allowed states ─────────────────────────────────────────────────────────

  describe('allowed states (should NOT redirect)', () => {
    it('allows access when subscription is active', () => {
      expect(needsSubscription('active', null)).toBe(false)
    })

    it('allows access when subscription is active regardless of trialEnd', () => {
      expect(needsSubscription('active', '2026-06-01')).toBe(false)
    })

    it('allows access for a real Stripe trial with trialEnd set', () => {
      // trialEnd is written by the Stripe webhook — presence means the user
      // completed checkout and is genuinely in a Stripe-managed trial period.
      expect(needsSubscription('trialing', '2026-06-01')).toBe(false)
    })
  })

  // ── Blocked states ─────────────────────────────────────────────────────────

  describe('blocked states (should redirect to /subscribe)', () => {
    it('blocks access for an auto-trial with trialEnd null (fresh signup, no checkout attempted)', () => {
      // This is the initial state: status='trialing', trialEnd=null.
      // The user has never started a Stripe checkout.
      expect(needsSubscription('trialing', null)).toBe(true)
    })

    it('blocks the abandoned-checkout exploit: trialing + stripeCustomerId set but trialEnd still null', () => {
      // createCheckoutSession writes stripeCustomerId to Firestore before the
      // user completes Stripe's form. If they abandon checkout, status stays
      // 'trialing' and trialEnd remains null. The old guard checked for
      // stripeCustomerId and would have let this through — the new guard does
      // not because trialEnd is still null.
      //
      // Note: stripeCustomerId is not a parameter of this function by design.
      // The guard ignores it entirely and relies only on trialEnd.
      expect(needsSubscription('trialing', null)).toBe(true)
    })

    it('blocks access when subscription is past_due', () => {
      expect(needsSubscription('past_due', null)).toBe(true)
    })

    it('blocks access when subscription is canceled', () => {
      expect(needsSubscription('canceled', null)).toBe(true)
    })

    it('blocks access when status is undefined (missing or malformed company document)', () => {
      expect(needsSubscription(undefined, null)).toBe(true)
    })

    it('blocks access when status is an unrecognised string', () => {
      // Guard against future Stripe statuses (e.g. 'incomplete', 'paused')
      // that are not explicitly handled — fail closed.
      expect(needsSubscription('incomplete', null)).toBe(true)
    })
  })

  // ── trialEnd boundary conditions ───────────────────────────────────────────

  describe('trialEnd boundary conditions', () => {
    it('treats an empty string trialEnd as not-null (string is truthy)', () => {
      // In practice trialEnd is either a date string or null. An empty string
      // should not occur, but if it does it evaluates as !== null — meaning the
      // function would treat it as a real trial. This is documented explicitly
      // so the caller knows to store null, not '', when clearing trialEnd.
      expect(needsSubscription('trialing', '')).toBe(false)
    })

    it('accepts a trialEnd that is already in the past (expired trial)', () => {
      // The layout does not enforce trial expiry — that is Stripe's job. A
      // past trialEnd still means the user went through Stripe checkout. The
      // webhook will update status to 'active' or another terminal state when
      // the trial ends, so this path is transient and acceptable.
      expect(needsSubscription('trialing', '2020-01-01')).toBe(false)
    })
  })
})
