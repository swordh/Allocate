/**
 * lib/billingEmailFlag.ts — clears `companies/{id}.billing` on the read
 * path when Stripe already has an email on the customer again, so an admin
 * doesn't have to wait for the weekly `billingEmailReminder` sweep.
 *
 * Stripe and Firebase Admin are mocked; no network calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CompanyBilling } from '@/types'

const { mockCustomersRetrieve, mockUpdate, mockDoc } = vi.hoisted(() => {
  const mockUpdate = vi.fn().mockResolvedValue(undefined)
  return {
    mockCustomersRetrieve: vi.fn(),
    mockUpdate,
    mockDoc: vi.fn(() => ({ update: mockUpdate })),
  }
})

vi.mock('@/lib/stripe', () => ({
  stripe: {
    customers: { retrieve: mockCustomersRetrieve },
  },
}))

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: { doc: mockDoc },
}))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: () => '__delete__' },
}))

import { resolveBillingEmailFlag } from '@/lib/billingEmailFlag'

const COMPANY_ID = 'company-A'
const STRIPE_CUSTOMER_ID = 'cus_123'

const BILLING: CompanyBilling = {
  emailMissingSince: '2026-09-01T00:00:00.000Z',
  lastReminderAt: '2026-09-01T00:00:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolveBillingEmailFlag', () => {
  it('clears the flag and returns null when Stripe has an email on the customer', async () => {
    mockCustomersRetrieve.mockResolvedValue({ deleted: false, email: 'anna@example.com' })

    const result = await resolveBillingEmailFlag(COMPANY_ID, STRIPE_CUSTOMER_ID, BILLING)

    expect(result).toBeNull()
    expect(mockDoc).toHaveBeenCalledWith(`companies/${COMPANY_ID}`)
    expect(mockUpdate).toHaveBeenCalledWith({ billing: '__delete__' })
  })

  it('leaves the flag unchanged when the customer still has no email', async () => {
    mockCustomersRetrieve.mockResolvedValue({ deleted: false, email: '' })

    const result = await resolveBillingEmailFlag(COMPANY_ID, STRIPE_CUSTOMER_ID, BILLING)

    expect(result).toBe(BILLING)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('leaves the flag unchanged when the Stripe customer is deleted', async () => {
    mockCustomersRetrieve.mockResolvedValue({ deleted: true })

    const result = await resolveBillingEmailFlag(COMPANY_ID, STRIPE_CUSTOMER_ID, BILLING)

    expect(result).toBe(BILLING)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('leaves the flag unchanged, without throwing, when the Stripe call fails', async () => {
    mockCustomersRetrieve.mockRejectedValue(new Error('stripe outage'))

    const result = await resolveBillingEmailFlag(COMPANY_ID, STRIPE_CUSTOMER_ID, BILLING)

    expect(result).toBe(BILLING)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('makes no Stripe call when there is no flag set', async () => {
    const result = await resolveBillingEmailFlag(COMPANY_ID, STRIPE_CUSTOMER_ID, null)

    expect(result).toBeNull()
    expect(mockCustomersRetrieve).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('makes no Stripe call when there is no stripeCustomerId', async () => {
    const result = await resolveBillingEmailFlag(COMPANY_ID, undefined, BILLING)

    expect(result).toBe(BILLING)
    expect(mockCustomersRetrieve).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})
