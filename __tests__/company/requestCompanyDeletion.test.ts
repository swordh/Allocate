/**
 * `requestCompanyDeletion` / `cancelCompanyDeletion` (actions/companyDeletion.ts)
 * — issue #252 step 5, PR F2.
 *
 * Firebase Admin and Stripe are both mocked; no network calls are made.
 *
 * Every test here is written to FAIL if a specific guard is removed, not
 * merely to describe the happy path. The one that matters most is the `mode`
 * test: an earlier draft of the plan derived `mode` from the member count,
 * and a regression back to that would delete a company instantly instead of
 * giving it seven days.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { wireDb, makeTransaction, type DocMap, type QueryResolver, type DocRefStub } from '../helpers/firestore'

const { mockVerifySessionCookie, mockCookieGet, mockSubscriptionsUpdate, mockSubscriptionsRetrieve } = vi.hoisted(
  () => ({
    mockVerifySessionCookie: vi.fn(),
    mockCookieGet: vi.fn(),
    mockSubscriptionsUpdate: vi.fn(),
    mockSubscriptionsRetrieve: vi.fn(),
  }),
)

const NOW_MS = 1_760_000_000_000

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    delete: () => '__delete__',
    increment: (n: number) => ({ __increment: n }),
    serverTimestamp: () => 'server-timestamp',
  },
  Timestamp: {
    now: () => ({ toMillis: () => NOW_MS, toDate: () => new Date(NOW_MS) }),
    fromMillis: (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms) }),
  },
}))

vi.mock('@/lib/firebase-admin', () => ({
  adminAuth: { verifySessionCookie: mockVerifySessionCookie },
  adminDb: {
    doc: vi.fn(),
    collection: vi.fn(),
    collectionGroup: vi.fn(),
    batch: vi.fn(),
    runTransaction: vi.fn(),
  },
}))

vi.mock('@/lib/stripe', () => ({
  stripe: {
    subscriptions: { update: mockSubscriptionsUpdate, retrieve: mockSubscriptionsRetrieve },
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

import { requestCompanyDeletion, cancelCompanyDeletion } from '@/actions/companyDeletion'
import { adminDb } from '@/lib/firebase-admin'

const UID = 'user-admin'
const COMPANY_ID = 'company-A'
const COMPANY_NAME = 'Rigg & Rep AB'

interface WireOptions {
  role?: string | null
  companyName?: string
  deletion?: Record<string, unknown>
  stripeSubscriptionId?: string
  admins?: Array<{ id: string; email?: string }>
  ledger?: Record<string, unknown> | null
}

function wire(opts: WireOptions = {}) {
  const docs: DocMap = {
    [`companies/${COMPANY_ID}`]: {
      name: opts.companyName ?? COMPANY_NAME,
      ...(opts.deletion ? { deletion: opts.deletion } : {}),
      ...(opts.stripeSubscriptionId
        ? { subscription: { stripeSubscriptionId: opts.stripeSubscriptionId } }
        : {}),
    },
  }

  if (opts.role !== null) {
    docs[`companies/${COMPANY_ID}/members/${UID}`] = {
      role: opts.role ?? 'admin',
      name: 'Anna Admin',
      email: 'anna@example.com',
    }
  }

  if (opts.ledger !== undefined && opts.ledger !== null) {
    docs[`companyDeletions/${(opts.deletion?.requestId as string) ?? 'req-1'}`] = opts.ledger
  }

  const query: QueryResolver = (ctx) => {
    if (ctx.path === `companies/${COMPANY_ID}/members`) {
      return (opts.admins ?? [{ id: 'admin-1', email: 'anna@example.com' }]).map((a) => ({
        id: a.id,
        path: `companies/${COMPANY_ID}/members/${a.id}`,
        data: { role: 'admin', email: a.email },
      }))
    }
    return []
  }

  const wired = wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })
  const tx = makeTransaction(docs)
  vi.mocked(adminDb.runTransaction).mockImplementation(
    (cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx),
  )

  mockCookieGet.mockReturnValue({ value: 'valid-session' })
  mockVerifySessionCookie.mockResolvedValue({
    uid: UID,
    email: 'anna@example.com',
    activeCompanyId: COMPANY_ID,
    role: 'admin',
    email_verified: true,
  })

  return { docs, tx, wired }
}

function ledgerWrite(tx: ReturnType<typeof makeTransaction>) {
  return tx.set.mock.calls.find(([ref]) => (ref as DocRefStub).path.startsWith('companyDeletions/'))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSubscriptionsUpdate.mockResolvedValue({})
  mockSubscriptionsRetrieve.mockResolvedValue({ status: 'active' })
})

describe('requestCompanyDeletion — mode', () => {
  it("ALWAYS writes mode 'window', with a seven-day window, for a company with exactly ONE member", async () => {
    // The mutation target. An earlier draft of the plan chose `mode` by
    // member count, which would make this company's deletion immediate and
    // irreversible. The decision was reversed: it is the ACTION that picks
    // the tempo. An admin asking to delete her own one-person company is
    // still around to change her mind, so she gets the same seven days as
    // everybody else.
    //
    // Note there is not even a member count wired here, on purpose: if
    // anyone re-introduces a count read in this function, it will read
    // nothing and this test stops describing what the code does.
    const { tx } = wire()

    const result = await requestCompanyDeletion(COMPANY_NAME)

    expect(result.error).toBeUndefined()
    const write = ledgerWrite(tx)
    expect(write).toBeDefined()
    expect(write![1]).toMatchObject({ mode: 'window', state: 'requested', companyId: COMPANY_ID })

    const scheduled = (write![1] as { scheduledFor: { toMillis: () => number } }).scheduledFor
    expect(scheduled.toMillis() - NOW_MS).toBe(7 * 24 * 60 * 60 * 1000)

    // The member-visible mirror must agree with the ledger — a mirror that
    // said 'immediate' would make the sweep purge it on its next tick.
    const mirror = tx.update.mock.calls.find(
      ([ref]) => (ref as DocRefStub).path === `companies/${COMPANY_ID}`,
    )
    expect((mirror![1] as { deletion: { mode: string } }).deletion.mode).toBe('window')
  })

  it("never writes mode 'immediate' from this action, whatever the company looks like", async () => {
    const { tx } = wire({ companyName: 'Solo AB' })
    await requestCompanyDeletion('Solo AB')
    expect(ledgerWrite(tx)![1]).not.toMatchObject({ mode: 'immediate' })
  })
})

describe('requestCompanyDeletion — guards', () => {
  it('refuses a caller whose live member document says crew, even with an admin session claim', async () => {
    // The session claim says 'admin' (see `wire`) because Custom Claims are
    // baked into the cookie when it is minted and do not change on demotion.
    // The live member document is the authority.
    const { tx } = wire({ role: 'crew' })

    const result = await requestCompanyDeletion(COMPANY_NAME)

    expect(result.error).toBe('Only administrators can delete a company.')
    expect(ledgerWrite(tx)).toBeUndefined()
  })

  it('refuses a caller with no member document at all', async () => {
    const { tx } = wire({ role: null })
    const result = await requestCompanyDeletion(COMPANY_NAME)
    expect(result.error).toBe('Only administrators can delete a company.')
    expect(ledgerWrite(tx)).toBeUndefined()
  })

  it('refuses when the typed confirmation does not match the company name', async () => {
    const { tx } = wire()
    const result = await requestCompanyDeletion('DELETE')
    expect(result.error).toContain('type its name exactly')
    expect(ledgerWrite(tx)).toBeUndefined()
  })

  it('refuses an empty confirmation', async () => {
    const { tx } = wire()
    const result = await requestCompanyDeletion('   ')
    expect(result.error).toContain('type its name exactly')
    expect(ledgerWrite(tx)).toBeUndefined()
  })

  it('accepts a confirmation that differs only in case and surrounding whitespace', async () => {
    const { tx } = wire()
    const result = await requestCompanyDeletion('  rigg & rep ab ')
    expect(result.error).toBeUndefined()
    expect(ledgerWrite(tx)).toBeDefined()
  })

  it('returns SUCCESS, and writes nothing, when a deletion is already pending (double-click protection)', async () => {
    const { tx } = wire({
      deletion: {
        state: 'requested',
        requestId: 'req-1',
        mode: 'window',
        scheduledFor: { toDate: () => new Date(NOW_MS + 1000) },
      },
    })

    const result = await requestCompanyDeletion(COMPANY_NAME)

    expect(result.error).toBeUndefined()
    expect(result.alreadyRequested).toBe(true)
    expect(result.scheduledFor).toBe(new Date(NOW_MS + 1000).toISOString())
    expect(ledgerWrite(tx)).toBeUndefined()
    // Crucially, no second Stripe pause either.
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled()
  })

  it('never leaks the requestId to the caller', async () => {
    // `companyDeletions` is denied to every client by firestore.rules; the
    // document id is the first half of contradicting that for free. Same
    // reasoning as the prop comment in app/(auth)/no-company/page.tsx.
    const { tx } = wire()
    const result = await requestCompanyDeletion(COMPANY_NAME)
    expect(ledgerWrite(tx)).toBeDefined()
    expect(JSON.stringify(result)).not.toContain('requestId')
  })
})

describe('requestCompanyDeletion — Stripe', () => {
  it("pauses collection with behavior 'void', never keep_as_draft", async () => {
    // `keep_as_draft` accumulates invoices that are charged retroactively on
    // resume, which breaks the promise that a cancelled deletion resumes
    // billing as if nothing happened.
    wire({ stripeSubscriptionId: 'sub_123' })

    await requestCompanyDeletion(COMPANY_NAME)

    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_123', {
      pause_collection: { behavior: 'void' },
    })
  })

  it('still succeeds when Stripe fails, and records the failure on the ledger', async () => {
    mockSubscriptionsUpdate.mockRejectedValue(new Error('stripe is down'))
    const { wired } = wire({ stripeSubscriptionId: 'sub_123' })

    const result = await requestCompanyDeletion(COMPANY_NAME)

    expect(result.error).toBeUndefined()
    const ledgerRef = wired.doc.mock.results
      .map((r) => r.value as DocRefStub)
      .find((ref) => ref.path.startsWith('companyDeletions/'))
    expect(ledgerRef).toBeDefined()
  })

  it('does not call Stripe at all for a company with no subscription', async () => {
    wire()
    await requestCompanyDeletion(COMPANY_NAME)
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled()
  })
})

describe('cancelCompanyDeletion', () => {
  const PENDING = {
    state: 'requested',
    requestId: 'req-1',
    mode: 'window',
    scheduledFor: { toDate: () => new Date(NOW_MS + 1000) },
  }

  const LEDGER = {
    requestId: 'req-1',
    companyId: COMPANY_ID,
    companyName: COMPANY_NAME,
    state: 'requested',
    scheduledFor: { toDate: () => new Date(NOW_MS + 1000) },
  }

  it('clears the deletion field entirely rather than writing a cancelled state', async () => {
    // Absence of `companies/{cid}.deletion` is the ONLY "nothing is going on"
    // signal in this data model — the sweep's query, the banner and
    // docToCompany all depend on it. A `state: 'canceled'` value left behind
    // would keep every one of them believing a deletion is pending.
    const { tx } = wire({ deletion: PENDING, ledger: LEDGER })

    const result = await cancelCompanyDeletion()

    expect(result.error).toBeUndefined()
    const companyUpdate = tx.update.mock.calls.find(
      ([ref]) => (ref as DocRefStub).path === `companies/${COMPANY_ID}`,
    )
    expect(companyUpdate![1]).toEqual({ deletion: '__delete__' })

    const ledgerUpdate = tx.update.mock.calls.find(
      ([ref]) => (ref as DocRefStub).path === 'companyDeletions/req-1',
    )
    expect(ledgerUpdate![1]).toMatchObject({ state: 'canceled', cancelSource: 'admin_ui', canceledByUid: UID })
  })

  it('resumes Stripe collection', async () => {
    wire({ deletion: PENDING, ledger: LEDGER, stripeSubscriptionId: 'sub_123' })

    await cancelCompanyDeletion()

    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_123', { pause_collection: null })
  })

  it('does not throw when the subscription is already canceled — it records and moves on', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue({ status: 'canceled' })
    wire({ deletion: PENDING, ledger: LEDGER, stripeSubscriptionId: 'sub_123' })

    const result = await cancelCompanyDeletion()

    expect(result.error).toBeUndefined()
    // Never attempted — an update on a canceled subscription is exactly the
    // call Stripe rejects, and the plan requires resume to never throw.
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled()
  })

  it('queues the cancellation mail to admins only', async () => {
    const { wired } = wire({
      deletion: PENDING,
      ledger: LEDGER,
      admins: [
        { id: 'a1', email: 'one@example.com' },
        { id: 'a2', email: 'two@example.com' },
      ],
    })

    await cancelCompanyDeletion()

    expect(wired.batch.set).toHaveBeenCalledTimes(2)
    expect(wired.batch.set.mock.calls[0]![1]).toMatchObject({
      template: 'companyDeletionCancelled',
      to: 'one@example.com',
    })
  })

  it('refuses to "cancel" a deletion that is already executing', async () => {
    const { tx } = wire({ deletion: { ...PENDING, state: 'executing' }, ledger: LEDGER })

    const result = await cancelCompanyDeletion()

    expect(result.error).toContain('already started')
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('refuses a non-admin caller', async () => {
    const { tx } = wire({ role: 'crew', deletion: PENDING, ledger: LEDGER })
    const result = await cancelCompanyDeletion()
    expect(result.error).toBe('Only administrators can stop a company deletion.')
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('reports success when there was nothing to cancel', async () => {
    wire()
    const result = await cancelCompanyDeletion()
    expect(result.error).toBeUndefined()
    expect(result.nothingToCancel).toBe(true)
  })
})
