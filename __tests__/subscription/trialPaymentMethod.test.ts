/**
 * lib/trialPaymentMethod.ts — live Stripe lookup for whether a trialing
 * subscription already has a payment method on file, so the TRIAL notice
 * doesn't ask for a card Checkout already collected.
 *
 * Stripe is mocked; no network calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Subscription } from '@/types'

const { mockSubscriptionsRetrieve } = vi.hoisted(() => ({
  mockSubscriptionsRetrieve: vi.fn(),
}))

vi.mock('@/lib/stripe', () => ({
  stripe: {
    subscriptions: { retrieve: mockSubscriptionsRetrieve },
  },
}))

import { trialHasPaymentMethod } from '@/lib/trialPaymentMethod'

function sub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    status: 'trialing',
    plan: 'starter',
    stripeSubscriptionId: 'sub_123',
    currentPeriodEnd: '2026-09-05T20:43:22.000Z',
    limits: { equipment: 25, users: 10 },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('trialHasPaymentMethod', () => {
  it('true when the subscription itself has a default payment method', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue({
      default_payment_method: 'pm_123',
      customer: { deleted: false },
    })

    expect(await trialHasPaymentMethod(sub())).toBe(true)
    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith('sub_123', { expand: ['customer'] })
  })

  it('true when the customer has a default payment method in invoice_settings', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue({
      default_payment_method: null,
      customer: { deleted: false, invoice_settings: { default_payment_method: 'pm_456' } },
    })

    expect(await trialHasPaymentMethod(sub())).toBe(true)
  })

  it('true when the customer has a legacy default_source', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue({
      default_payment_method: null,
      customer: { deleted: false, invoice_settings: {}, default_source: 'card_789' },
    })

    expect(await trialHasPaymentMethod(sub())).toBe(true)
  })

  it('false when neither the subscription nor the customer has a payment method', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue({
      default_payment_method: null,
      customer: { deleted: false, invoice_settings: {}, default_source: null },
    })

    expect(await trialHasPaymentMethod(sub())).toBe(false)
  })

  it('false when the customer is deleted', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue({
      default_payment_method: null,
      customer: { deleted: true },
    })

    expect(await trialHasPaymentMethod(sub())).toBe(false)
  })

  it('makes no call when the subscription is not trialing', async () => {
    expect(await trialHasPaymentMethod(sub({ status: 'active' }))).toBe(false)
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled()
  })

  it('makes no call when there is no subscription', async () => {
    expect(await trialHasPaymentMethod(null)).toBe(false)
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled()
  })

  it('makes no call when trialing but stripeSubscriptionId is missing', async () => {
    expect(await trialHasPaymentMethod(sub({ stripeSubscriptionId: undefined }))).toBe(false)
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled()
  })

  it('false, without throwing, when the Stripe call fails', async () => {
    mockSubscriptionsRetrieve.mockRejectedValue(new Error('stripe outage'))

    expect(await trialHasPaymentMethod(sub())).toBe(false)
  })
})
