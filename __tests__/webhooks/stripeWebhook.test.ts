/**
 * Tests for the Stripe webhook route — app/api/webhooks/stripe/route.ts.
 *
 * This is the first test coverage the webhook has ever had. It introduces the
 * Stripe-mock pattern used here (there was no established one anywhere in the
 * repo): fake `stripe.webhooks.constructEvent`, an in-memory `adminDb` keyed
 * by Firestore path, and a captured `next/server` `after()` so the
 * fire-and-forget async work started by POST can be awaited deterministically
 * instead of racing the assertions.
 *
 * Scope, per the #252 step 5 prep plan (PR B): the stale-event guard in
 * `handleSubscriptionDeleted` (newly added — it previously had none, unlike
 * `handleSubscriptionUpsert`), and `pauseCollection`/`pauseResumesAt`
 * mirroring in both directions. `mapStripeStatus` and the plan-change event
 * log are exercised incidentally but are not the point of this file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Stripe from 'stripe'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('@/lib/stripe', () => ({
  stripe: {
    webhooks: {
      constructEvent: vi.fn(),
    },
  },
}))

vi.mock('@/lib/subscription', () => ({
  PRICE_ID_TO_PLAN: {
    price_basic_monthly: 'basic',
    price_starter_monthly: 'starter',
  },
  PLAN_LIMITS: {
    basic:   { equipment: 100, users: 30 },
    starter: { equipment: 25, users: 10 },
  },
}))

const afterCallbacks: Array<() => unknown> = []

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
  after: vi.fn((cb: () => unknown) => {
    afterCallbacks.push(cb)
  }),
}))

// ── In-memory Firestore double ───────────────────────────────────────────────
//
// Only what this route actually touches: `companies/{id}` (get/update, plus a
// where('stripeCustomerId', ...) query), `_stripeEvents/{id}` (get/set — the
// dedup ledger), and `companyEvents/{id}` (set — the audit log). Dot-path keys
// in `update()` are applied the way Firestore applies them, since the route
// writes 'subscription.status' etc. as flat dotted keys.

type Data = Record<string, unknown>

let companies: Record<string, Data>
let stripeEvents: Set<string>
let companyEvents: Record<string, Data>

function applyDotUpdate(target: Data, updates: Record<string, unknown>) {
  for (const [key, value] of Object.entries(updates)) {
    const parts = key.split('.')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- traversing an untyped nested store
    let obj: any = target
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      if (typeof obj[part] !== 'object' || obj[part] === null) obj[part] = {}
      obj = obj[part]
    }
    obj[parts[parts.length - 1]] = value
  }
}

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {
    doc: vi.fn(),
    collection: vi.fn(),
  },
  adminAuth: {},
}))

import { adminDb } from '@/lib/firebase-admin'
import { stripe } from '@/lib/stripe'
import { POST } from '@/app/api/webhooks/stripe/route'

function wireAdminDb() {
  vi.mocked(adminDb.doc).mockImplementation(((path: string) => {
    const [collection, id] = path.split('/')

    if (collection === '_stripeEvents') {
      return {
        get: async () => ({ exists: stripeEvents.has(id) }),
        set: async () => {
          stripeEvents.add(id)
        },
      }
    }

    if (collection === 'companies') {
      return {
        get: async () => ({
          exists: id in companies,
          data: () => companies[id],
        }),
        update: async (updates: Record<string, unknown>) => {
          if (!(id in companies)) throw new Error(`doc companies/${id} does not exist`)
          applyDotUpdate(companies[id], updates)
        },
      }
    }

    throw new Error(`Unhandled doc() path in test double: ${path}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, not the real Firestore type
  }) as any)

  vi.mocked(adminDb.collection).mockImplementation(((name: string) => {
    if (name === 'companies') {
      return {
        where: (field: string, _op: string, value: unknown) => ({
          limit: () => ({
            get: async () => {
              const matches = Object.entries(companies).filter(([, data]) => data[field] === value)
              return {
                empty: matches.length === 0,
                docs: matches.map(([cid, data]) => ({ id: cid, data: () => data })),
              }
            },
          }),
        }),
      }
    }

    // logSubscriptionEvent's audit trail — not the focus of this file, but it
    // fires on every status/plan change these tests trigger, so it must not
    // throw and mask the assertions below behind a swallowed handler error.
    if (name === 'companyEvents') {
      return {
        doc: (id: string) => ({
          set: async (data: Data) => {
            companyEvents[id] = data
          },
        }),
      }
    }

    throw new Error(`Unhandled collection() name in test double: ${name}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, not the real Firestore type
  }) as any)
}

// ── Test helpers ──────────────────────────────────────────────────────────────

function fakeRequest() {
  return {
    text: async () => '{}',
    headers: { get: (name: string) => (name === 'stripe-signature' ? 'sig_test' : null) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- NextRequest is a type-only import in route.ts
  } as any
}

async function callWebhook(event: Partial<Stripe.Event>) {
  vi.mocked(stripe.webhooks.constructEvent).mockReturnValue(event as Stripe.Event)
  const response = await POST(fakeRequest())
  // POST fires processing via `after()` without awaiting it — drain every
  // captured callback so the assertions below see the finished write.
  await Promise.all(afterCallbacks.splice(0).map((cb) => cb()))
  return response
}

function subscriptionEvent(overrides: {
  id: string
  created: number
  subscription: Partial<Stripe.Subscription> & { id: string; customer: string; status: Stripe.Subscription.Status }
  type: 'customer.subscription.updated' | 'customer.subscription.deleted' | 'customer.subscription.created'
}): Partial<Stripe.Event> {
  return {
    id: overrides.id,
    created: overrides.created,
    type: overrides.type,
    data: { object: overrides.subscription as Stripe.Subscription },
  } as Partial<Stripe.Event>
}

function baseSub(overrides: Partial<Stripe.Subscription> = {}) {
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active' as Stripe.Subscription.Status,
    cancel_at_period_end: false,
    cancel_at: null,
    trial_end: null,
    pause_collection: null,
    items: {
      data: [
        {
          price: { id: 'price_basic_monthly' },
          plan: { interval: 'month' },
          current_period_end: 1_700_000_000,
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription
}

beforeEach(() => {
  vi.clearAllMocks()
  afterCallbacks.length = 0
  companies = {}
  stripeEvents = new Set()
  companyEvents = {}
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'
  wireAdminDb()
})

// ── handleSubscriptionDeleted: stale-event guard ─────────────────────────────

describe('customer.subscription.deleted — stale-event guard', () => {
  it('does not overwrite a newer stored state with an older delivery', async () => {
    companies['co1'] = {
      stripeCustomerId: 'cus_1',
      subscription: { status: 'active', plan: 'basic', stripeUpdatedAt: 2000, pauseCollection: 'void' },
    }

    await callWebhook(
      subscriptionEvent({
        id: 'evt_del_stale',
        created: 1000, // older than the stored 2000
        type: 'customer.subscription.deleted',
        subscription: baseSub({ status: 'canceled' }),
      }),
    )

    // Mutation-test proof: this is the exact assertion that fails the moment
    // the stale guard is removed from handleSubscriptionDeleted — a stale
    // 'canceled' delivery would otherwise flip status and clear the pause.
    expect(companies['co1'].subscription).toMatchObject({
      status: 'active',
      stripeUpdatedAt: 2000,
      pauseCollection: 'void',
    })
  })

  it('applies a delivery newer than the stored state, clearing status and pause fields', async () => {
    companies['co1'] = {
      stripeCustomerId: 'cus_1',
      subscription: { status: 'active', plan: 'basic', stripeUpdatedAt: 2000, pauseCollection: 'void', pauseResumesAt: '2026-01-01T00:00:00.000Z' },
    }

    await callWebhook(
      subscriptionEvent({
        id: 'evt_del_fresh',
        created: 3000, // newer than the stored 2000
        type: 'customer.subscription.deleted',
        subscription: baseSub({ status: 'canceled' }),
      }),
    )

    expect(companies['co1'].subscription).toMatchObject({
      status: 'canceled',
      stripeUpdatedAt: 3000,
      pauseCollection: null,
      pauseResumesAt: null,
    })

    // Proves the audit-log write in logSubscriptionEvent (companyEvents/{eventId})
    // actually ran rather than throwing and being swallowed by
    // processStripeEvent's catch — a silent throw there would still leave the
    // assertion above passing for the wrong reason.
    expect(companyEvents['evt_del_fresh']).toMatchObject({
      companyId: 'co1',
      kind: 'status_changed',
      fromStatus: 'active',
      toStatus: 'canceled',
    })
  })

  it('is a no-op when the company cannot be found by customer id', async () => {
    await callWebhook(
      subscriptionEvent({
        id: 'evt_del_missing',
        created: 1,
        type: 'customer.subscription.deleted',
        subscription: baseSub({ customer: 'cus_unknown', status: 'canceled' }),
      }),
    )

    expect(companies).toEqual({})
  })
})

// ── pause_collection mirroring ───────────────────────────────────────────────

describe('customer.subscription.updated — pause_collection mirroring', () => {
  it('mirrors behavior and resumes_at onto the company subscription', async () => {
    companies['co1'] = {
      stripeCustomerId: 'cus_1',
      subscription: { status: 'active', plan: 'basic', stripeUpdatedAt: 0 },
    }

    await callWebhook(
      subscriptionEvent({
        id: 'evt_pause',
        created: 1000,
        type: 'customer.subscription.updated',
        subscription: baseSub({
          pause_collection: { behavior: 'void', resumes_at: 1_700_100_000 },
        }),
      }),
    )

    expect(companies['co1'].subscription).toMatchObject({
      pauseCollection: 'void',
      pauseResumesAt: new Date(1_700_100_000 * 1000).toISOString(),
    })
  })

  it('clears both fields to null when Stripe reports collection resumed', async () => {
    companies['co1'] = {
      stripeCustomerId: 'cus_1',
      subscription: {
        status: 'active',
        plan: 'basic',
        stripeUpdatedAt: 1000,
        pauseCollection: 'void',
        pauseResumesAt: new Date(1_700_100_000 * 1000).toISOString(),
      },
    }

    await callWebhook(
      subscriptionEvent({
        id: 'evt_resume',
        created: 2000,
        type: 'customer.subscription.updated',
        subscription: baseSub({ pause_collection: null }),
      }),
    )

    expect(companies['co1'].subscription).toMatchObject({
      pauseCollection: null,
      pauseResumesAt: null,
    })
  })
})

// ── #305: cancellation mirroring + feed entries ──────────────────────────────

describe('customer.subscription.updated — cancellation (#305)', () => {
  const CANCEL_AT = 1_700_000_000
  const CANCEL_AT_ISO = new Date(CANCEL_AT * 1000).toISOString()

  function company(sub: Data = {}) {
    return {
      stripeCustomerId: 'cus_1',
      subscription: { status: 'active', plan: 'basic', stripeUpdatedAt: 1000, ...sub },
    }
  }

  function update(id: string, created: number, sub: Partial<Stripe.Subscription>) {
    return callWebhook(
      subscriptionEvent({
        id,
        created,
        type: 'customer.subscription.updated',
        subscription: baseSub(sub) as unknown as Parameters<typeof subscriptionEvent>[0]['subscription'],
      }),
    )
  }

  it("Billing Portal's real shape (only cancel_at set) mirrors true + date and logs scheduled", async () => {
    companies['co1'] = company()

    // cancel_at_period_end stays false, exactly as Stripe sends it from the portal.
    await update('evt_cancel', 2000, { cancel_at: CANCEL_AT, cancel_at_period_end: false })

    expect(companies['co1'].subscription).toMatchObject({
      cancelAtPeriodEnd: true,
      cancelAt: CANCEL_AT_ISO,
    })
    expect(companyEvents['evt_cancel:cancellation']).toMatchObject({
      companyId: 'co1',
      kind: 'cancellation_scheduled',
      effectiveAt: CANCEL_AT_ISO,
      stripeEventId: 'evt_cancel',
      stripeSubscriptionId: 'sub_1',
    })
  })

  it('reverting (cancel_at back to null) mirrors false/null and logs reverted', async () => {
    companies['co1'] = company({ cancelAtPeriodEnd: true, cancelAt: CANCEL_AT_ISO })

    await update('evt_renew', 2000, { cancel_at: null, cancel_at_period_end: false })

    expect(companies['co1'].subscription).toMatchObject({
      cancelAtPeriodEnd: false,
      cancelAt: null,
    })
    expect(companyEvents['evt_renew:cancellation']).toMatchObject({
      kind: 'cancellation_reverted',
      effectiveAt: null,
    })
  })

  it('cancel_at_period_end alone (no cancel_at) also counts as scheduled', async () => {
    companies['co1'] = company()

    await update('evt_cape', 2000, { cancel_at: null, cancel_at_period_end: true })

    expect(companies['co1'].subscription).toMatchObject({ cancelAtPeriodEnd: true, cancelAt: null })
    expect(companyEvents['evt_cape:cancellation']).toMatchObject({
      kind: 'cancellation_scheduled',
      effectiveAt: null,
    })
  })

  it('logs nothing when the cancellation state is unchanged', async () => {
    companies['co1'] = company({ cancelAtPeriodEnd: true, cancelAt: CANCEL_AT_ISO })

    await update('evt_same', 2000, { cancel_at: CANCEL_AT })

    expect(companyEvents['evt_same:cancellation']).toBeUndefined()
    expect(Object.keys(companyEvents)).toEqual([])
  })

  it('logs nothing when no stored value exists and the subscription is not canceled', async () => {
    companies['co1'] = company() // no cancelAtPeriodEnd stored at all

    await update('evt_none', 2000, {})

    expect(Object.keys(companyEvents)).toEqual([])
  })

  it('writes two separate rows when plan and cancellation change in one event', async () => {
    companies['co1'] = company({ plan: 'starter' })

    await update('evt_both', 2000, { cancel_at: CANCEL_AT })

    expect(companyEvents['evt_both']).toMatchObject({ kind: 'plan_changed', toPlan: 'basic' })
    expect(companyEvents['evt_both:cancellation']).toMatchObject({ kind: 'cancellation_scheduled' })
    expect(Object.keys(companyEvents).sort()).toEqual(['evt_both', 'evt_both:cancellation'])
  })

  it('a redelivery of the same event collapses onto the same row id', async () => {
    const before = company()
    companies['co1'] = structuredClone(before)

    await update('evt_redeliver', 2000, { cancel_at: CANCEL_AT })

    // Simulate the non-transactional dedup ledger letting a redelivery through
    // before the first write landed: ledger and stored state are as they were.
    stripeEvents.clear()
    companies['co1'] = structuredClone(before)

    await update('evt_redeliver', 2000, { cancel_at: CANCEL_AT })

    expect(Object.keys(companyEvents)).toEqual(['evt_redeliver:cancellation'])
  })

  it('a stale event neither mirrors nor logs a cancellation', async () => {
    companies['co1'] = company({ stripeUpdatedAt: 5000 })

    await update('evt_stale_cancel', 2000, { cancel_at: CANCEL_AT })

    expect(companies['co1'].subscription).not.toHaveProperty('cancelAt')
    expect(companies['co1'].subscription).not.toHaveProperty('cancelAtPeriodEnd')
    expect(Object.keys(companyEvents)).toEqual([])
  })
})
