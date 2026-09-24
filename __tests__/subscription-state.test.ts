import { describe, it, expect } from 'vitest'
import { toSubState, getSubStateDisplay, getPlanCardCta } from '@/lib/subscription-state'
import type { CompanyDeletion, Subscription } from '@/types'

function sub(overrides: Partial<Subscription>): Subscription {
  return {
    status: 'active',
    plan: 'starter',
    currentPeriodEnd: '2026-09-05T20:43:22.000Z',
    limits: { equipment: 25, users: 10 },
    ...overrides,
  }
}

describe('toSubState', () => {
  it('maps null to NONE', () => {
    expect(toSubState(null)).toBe('NONE')
  })

  it('maps trialing to TRIAL', () => {
    expect(toSubState(sub({ status: 'trialing' }))).toBe('TRIAL')
  })

  it('maps active to ACTIVE', () => {
    expect(toSubState(sub({ status: 'active', cancelAtPeriodEnd: false }))).toBe('ACTIVE')
  })

  it('maps active with cancelAtPeriodEnd true to CANCELED', () => {
    // Stripe does not flip status until the period actually ends — the
    // design's "Access ends <date>" copy applies here even though Stripe
    // still reports the subscription as active.
    expect(toSubState(sub({ status: 'active', cancelAtPeriodEnd: true }))).toBe('CANCELED')
  })

  it('maps past_due to PAST_DUE', () => {
    expect(toSubState(sub({ status: 'past_due' }))).toBe('PAST_DUE')
  })

  it('maps incomplete to PAST_DUE', () => {
    expect(toSubState(sub({ status: 'incomplete' }))).toBe('PAST_DUE')
  })

  it('maps canceled to CANCELED', () => {
    expect(toSubState(sub({ status: 'canceled' }))).toBe('CANCELED')
  })

  it('fails closed to NONE for an unrecognised status', () => {
    expect(toSubState(sub({ status: 'paused' as Subscription['status'] }))).toBe('NONE')
  })
})

describe('getSubStateDisplay', () => {
  it('NONE: has no subscription, uses mobile label/cta, neutral tone', () => {
    const d = getSubStateDisplay(null, 'Nordfilm AB')
    expect(d.hasSub).toBe(false)
    expect(d.label).toBe('NO PLAN')
    expect(d.cta).toBe('PICK A PLAN')
    expect(d.tone).toBe('neutral')
    expect(d.notice).toContain('Nordfilm AB has no active subscription')
  })

  it('ACTIVE: has no notice', () => {
    const d = getSubStateDisplay(sub({ status: 'active', interval: 'year' }), 'Nordfilm AB')
    expect(d.hasSub).toBe(true)
    expect(d.notice).toBeNull()
    expect(d.cycle).toContain('Billed yearly')
    expect(d.cycle).toContain('Sep 5, 2026')
  })

  it('TRIAL: notice mentions trial end and payment method, info tone', () => {
    const d = getSubStateDisplay(
      sub({ status: 'trialing', trialEnd: '2026-08-20T00:00:00.000Z' }),
      'Nordfilm AB',
    )
    expect(d.tone).toBe('info')
    expect(d.cta).toBe('ADD PAYMENT METHOD')
    expect(d.notice).toContain('Aug 20, 2026')
  })

  it('TRIAL without hasPaymentMethod opt: same as no opts at all', () => {
    const d = getSubStateDisplay(
      sub({ status: 'trialing', trialEnd: '2026-08-20T00:00:00.000Z' }),
      'Nordfilm AB',
      null,
      { hasPaymentMethod: false },
    )
    expect(d.cta).toBe('ADD PAYMENT METHOD')
    expect(d.notice).toContain('Add a payment method')
  })

  it('TRIAL with hasPaymentMethod: notice says the card will be charged, no CTA', () => {
    const d = getSubStateDisplay(
      sub({ status: 'trialing', trialEnd: '2026-08-20T00:00:00.000Z' }),
      'Nordfilm AB',
      null,
      { hasPaymentMethod: true },
    )
    expect(d.tone).toBe('info')
    expect(d.cta).toBe('')
    expect(d.notice).toBe('Your trial ends Aug 20, 2026. Your card will be charged then.')
  })

  it('hasPaymentMethod is ignored outside TRIAL — ACTIVE still has no notice', () => {
    const d = getSubStateDisplay(sub({ status: 'active' }), 'Nordfilm AB', null, { hasPaymentMethod: true })
    expect(d.notice).toBeNull()
    expect(d.cta).toBe('')
  })

  it('hasPaymentMethod is ignored outside TRIAL — PAST_DUE keeps its own notice/CTA', () => {
    const d = getSubStateDisplay(sub({ status: 'past_due' }), 'Nordfilm AB', null, { hasPaymentMethod: true })
    expect(d.cta).toBe('UPDATE CARD')
    expect(d.notice).not.toContain('Your card will be charged then.')
  })

  it('PAST_DUE: danger tone, references currentPeriodEnd', () => {
    const d = getSubStateDisplay(sub({ status: 'past_due' }), 'Nordfilm AB')
    expect(d.tone).toBe('danger')
    expect(d.accent).toBe('danger')
    expect(d.cta).toBe('UPDATE CARD')
    expect(d.notice).toContain('Sep 5, 2026')
  })

  it('CANCELED: neutral tone, cycle shows access end date', () => {
    const d = getSubStateDisplay(sub({ status: 'canceled' }), 'Nordfilm AB')
    expect(d.tone).toBe('neutral')
    expect(d.cta).toBe('RESUME PLAN')
    expect(d.cycle).toBe('Access ends Sep 5, 2026')
  })

  it('active + cancelAtPeriodEnd renders identically to a canceled subscription', () => {
    const d = getSubStateDisplay(sub({ status: 'active', cancelAtPeriodEnd: true }), 'Nordfilm AB')
    expect(d.key).toBe('CANCELED')
    expect(d.cta).toBe('RESUME PLAN')
  })
})

describe('getPlanCardCta', () => {
  it('no subscription: always CHOOSE <PLAN>, regardless of rank', () => {
    expect(getPlanCardCta('starter', null)).toBe('CHOOSE STARTER')
    expect(getPlanCardCta('basic', null)).toBe('CHOOSE BASIC')
  })

  it('on the plan itself: CURRENT PLAN', () => {
    expect(getPlanCardCta('basic', sub({ plan: 'basic' }))).toBe('CURRENT PLAN')
  })

  it('a more expensive plan than the current one: UPGRADE', () => {
    expect(getPlanCardCta('basic', sub({ plan: 'starter' }))).toBe('UPGRADE')
  })

  it('a cheaper plan than the current one: DOWNGRADE, not UPGRADE', () => {
    // Regression: on Basic, the Starter card must never read UPGRADE —
    // Starter is cheaper and has lower caps, so choosing it is a downgrade.
    expect(getPlanCardCta('starter', sub({ plan: 'basic' }))).toBe('DOWNGRADE')
  })
})

// ── DELETION_PENDING (issue #252 step 5) ──────────────────────────────────────

function deletion(overrides: Partial<CompanyDeletion> = {}): CompanyDeletion {
  return {
    state: 'requested',
    requestId: 'req-1',
    requestedAt: '2026-09-13T10:00:00.000Z',
    requestedByName: 'Anna Admin',
    scheduledFor: '2026-09-20T10:00:00.000Z',
    mode: 'window',
    ...overrides,
  }
}

describe('getSubStateDisplay — DELETION_PENDING', () => {
  it('derives the state from company.deletion, overriding an otherwise ACTIVE subscription', () => {
    const d = getSubStateDisplay(sub({ status: 'active' }), 'Nordfilm AB', deletion())
    expect(d.key).toBe('DELETION_PENDING')
    expect(d.label).toBe('DELETION REQUESTED')
    expect(d.cta).toBe('STOP DELETION')
  })

  it('says "deletion requested", never "canceled" or "paused"', () => {
    // The design brief is explicit that these are different messages to an
    // admin deciding whether to stop it, and that the product shows only the
    // latter today. `paused` is separately spoken for twice in this codebase.
    const d = getSubStateDisplay(sub({ status: 'active' }), 'Nordfilm AB', deletion())
    expect(d.label).not.toContain('CANCEL')
    expect(d.label).not.toContain('PAUSE')
    expect(d.notice).toContain('Anna Admin')
    expect(d.notice).toContain('Nordfilm AB')
  })

  it('names the no-refund rule, which is the thing users discover too late', () => {
    const d = getSubStateDisplay(sub({}), 'Nordfilm AB', deletion())
    expect(d.notice).toContain('not refunded')
  })

  it('applies to an executing deletion too — presence of the field is the check', () => {
    // There is no "cancelled" value in this data model; a cancelled deletion
    // removes the field. So no state comparison belongs here, and a future
    // `state === 'requested'` check would silently drop the banner exactly
    // when a company is being torn down.
    expect(getSubStateDisplay(sub({}), 'X', deletion({ state: 'executing' })).key).toBe('DELETION_PENDING')
    expect(getSubStateDisplay(sub({}), 'X', deletion({ state: 'failed' })).key).toBe('DELETION_PENDING')
  })

  it('applies even with no subscription at all', () => {
    const d = getSubStateDisplay(null, 'Nordfilm AB', deletion())
    expect(d.key).toBe('DELETION_PENDING')
    expect(d.hasSub).toBe(false)
  })

  it('MUTATION GUARD: toSubState is not the source — it must never return DELETION_PENDING', () => {
    // If someone routes the new state through toSubState, its locked tests
    // (in particular Stripe's `paused` → NONE, above) start fighting this
    // one. The state comes from company.deletion, not the subscription:
    // pause_collection leaves subscription.status untouched.
    for (const status of ['active', 'trialing', 'past_due', 'incomplete', 'canceled'] as const) {
      expect(toSubState(sub({ status }))).not.toBe('DELETION_PENDING')
    }
    expect(toSubState(null)).not.toBe('DELETION_PENDING')
  })

  it('without a deletion, every existing state is completely unchanged', () => {
    expect(getSubStateDisplay(sub({ status: 'active' }), 'X').key).toBe('ACTIVE')
    expect(getSubStateDisplay(sub({ status: 'past_due' }), 'X').key).toBe('PAST_DUE')
    expect(getSubStateDisplay(null, 'X').key).toBe('NONE')
    expect(getSubStateDisplay(sub({ status: 'active' }), 'X', null).key).toBe('ACTIVE')
  })
})
