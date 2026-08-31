import { describe, it, expect } from 'vitest'
import { toSubState, getSubStateDisplay, getPlanCardCta } from '@/lib/subscription-state'
import type { Subscription } from '@/types'

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
