/**
 * The Billing Portal guard (issue #252 step 5, PR F2) — actions/subscription.ts.
 *
 * Why this guard exists at all, when #252 step 5 otherwise introduces NO
 * product restrictions during the seven-day window: requesting a deletion
 * pauses collection with `behavior: 'void'`, which we can reverse. Cancelling
 * the SUBSCRIPTION from inside Stripe's own portal, we cannot — our resume
 * can only report `already_canceled`. Leaving the portal open would let a
 * customer through a door we promised to be able to walk them back out of.
 *
 * Stripe and Firebase Admin are mocked; no network calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { wireDb, type DocMap } from '../helpers/firestore'

// `PRICE_ENV_BY_PLAN` in actions/subscription.ts is built at module load, so
// these have to exist before the import below — `vi.hoisted` runs before the
// hoisted imports, a `beforeEach` does not.
vi.hoisted(() => {
  process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_starter_month'
  process.env.STRIPE_PRICE_STARTER_YEARLY = 'price_starter_year'
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example'
})

const {
  mockVerifySessionCookie,
  mockCookieGet,
  mockPortalCreate,
  mockCheckoutCreate,
  mockCustomersCreate,
  mockCustomersSearch,
  mockSubscriptionsRetrieve,
} = vi.hoisted(() => ({
  mockVerifySessionCookie: vi.fn(),
  mockCookieGet: vi.fn(),
  mockPortalCreate: vi.fn(),
  mockCheckoutCreate: vi.fn(),
  mockCustomersCreate: vi.fn(),
  mockCustomersSearch: vi.fn(),
  mockSubscriptionsRetrieve: vi.fn(),
}))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { increment: (n: number) => ({ __increment: n }), delete: () => '__delete__' },
  Timestamp: { now: () => ({ toMillis: () => 0, toDate: () => new Date(0) }), fromMillis: () => ({}) },
}))

vi.mock('@/lib/firebase-admin', () => ({
  adminAuth: { verifySessionCookie: mockVerifySessionCookie },
  adminDb: { doc: vi.fn(), collection: vi.fn(), collectionGroup: vi.fn(), batch: vi.fn(), runTransaction: vi.fn() },
}))

vi.mock('@/lib/stripe', () => ({
  stripe: {
    billingPortal: { sessions: { create: mockPortalCreate } },
    checkout: { sessions: { create: mockCheckoutCreate } },
    customers: { create: mockCustomersCreate, search: mockCustomersSearch },
    subscriptions: { retrieve: mockSubscriptionsRetrieve },
  },
}))

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: mockCookieGet, set: vi.fn(), delete: vi.fn() }),
}))

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string): never => {
    throw new Error(`REDIRECT:${url}`)
  }),
}))

import {
  createPortalSession,
  createPlanChangeSession,
  createCheckoutSession,
} from '@/actions/subscription'
import { adminDb } from '@/lib/firebase-admin'

const COMPANY_ID = 'company-A'

const PENDING_DELETION = {
  state: 'requested',
  requestId: 'req-1',
  mode: 'window',
  scheduledFor: '2026-09-20T10:00:00.000Z',
}

function wire({ deletion }: { deletion?: Record<string, unknown> } = {}) {
  const docs: DocMap = {
    [`companies/${COMPANY_ID}`]: {
      name: 'Rigg & Rep AB',
      stripeCustomerId: 'cus_123',
      subscription: { stripeSubscriptionId: 'sub_123', plan: 'starter' },
      ...(deletion ? { deletion } : {}),
    },
    [`companies/${COMPANY_ID}/_meta/equipmentCount`]: { count: 1 },
  }

  wireDb(adminDb as unknown as Record<string, unknown>, {
    docs,
    query: (ctx) => (ctx.path === `companies/${COMPANY_ID}/members` ? [{ id: 'm1', data: { role: 'admin' } }] : []),
  })

  mockCookieGet.mockReturnValue({ value: 'valid-session' })
  mockVerifySessionCookie.mockResolvedValue({
    uid: 'user-1',
    email: 'anna@example.com',
    activeCompanyId: COMPANY_ID,
    role: 'admin',
    email_verified: true,
  })
}

const GUARD_MESSAGE =
  'Billing cannot be changed while this company is scheduled for deletion. Stop the deletion first, and billing resumes on the same plan.'

beforeEach(() => {
  vi.clearAllMocks()
  mockPortalCreate.mockResolvedValue({ url: 'https://portal.example' })
  mockCheckoutCreate.mockResolvedValue({ url: 'https://checkout.example' })
  mockSubscriptionsRetrieve.mockResolvedValue({ items: { data: [{ id: 'si_1' }] } })
})

describe('Billing Portal guard while a deletion is pending', () => {
  it('refuses to open the portal', async () => {
    wire({ deletion: PENDING_DELETION })
    const result = await createPortalSession()
    expect(result).toEqual({ error: GUARD_MESSAGE })
    expect(mockPortalCreate).not.toHaveBeenCalled()
  })

  it('refuses the plan-change deep link too — it opens the same portal', async () => {
    wire({ deletion: PENDING_DELETION })
    const result = await createPlanChangeSession('starter', 'month')
    expect(result).toEqual({ error: GUARD_MESSAGE })
    expect(mockPortalCreate).not.toHaveBeenCalled()
  })

  it('refuses checkout: no charge may be made during the window, new subscription included', async () => {
    wire({ deletion: PENDING_DELETION })
    const result = await createCheckoutSession('month', 'starter')
    expect(result).toEqual({ error: GUARD_MESSAGE })
    expect(mockCheckoutCreate).not.toHaveBeenCalled()
    // Guarded before a Stripe customer would have been created.
    expect(mockCustomersCreate).not.toHaveBeenCalled()
  })
})

describe('Billing Portal with no deletion pending', () => {
  it('opens normally — the guard keys off the field existing, nothing else', async () => {
    // This is the half that makes the guard self-releasing: a cancelled
    // deletion deletes `companies/{cid}.deletion` outright, so the portal
    // reopens by itself with nothing to remember to unlock.
    wire()
    const result = await createPortalSession()
    expect(result).toEqual({ url: 'https://portal.example' })
    expect(mockPortalCreate).toHaveBeenCalledOnce()
  })

  it('still opens for a deletion that was cancelled (field removed)', async () => {
    wire({ deletion: undefined })
    expect(await createPortalSession()).toEqual({ url: 'https://portal.example' })
  })
})
