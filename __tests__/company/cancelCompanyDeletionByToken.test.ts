/**
 * The mailed cancellation link (issue #252 step 5, PR F2):
 * `lookupCancelToken` (lib/queries/companyDeletionCancel.ts) for rendering,
 * and `cancelCompanyDeletionByToken` (actions/companyDeletion.ts) for the
 * authoritative, transactional cancel behind the button.
 *
 * Firebase Admin and Stripe are mocked; no network calls are made.
 *
 * The two most important tests in this file are the ones that assert
 * NOTHING happens: rendering the page must not cancel a deletion, and a
 * token must not be spendable twice. Everything else is message quality.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { wireDb, makeTransaction, type DocMap, type QueryResolver, type DocRefStub } from '../helpers/firestore'

const { mockSubscriptionsUpdate, mockSubscriptionsRetrieve } = vi.hoisted(() => ({
  mockSubscriptionsUpdate: vi.fn(),
  mockSubscriptionsRetrieve: vi.fn(),
}))

/**
 * Real wall-clock "now", captured once at module load.
 *
 * `lookupCancelToken` compares `expiresAt` against the real `Date.now()` —
 * it is a plain read with no Firestore Timestamp involved — so a hardcoded
 * instant here would make every fixture look expired the moment the calendar
 * moved past it. Anchoring to the actual clock and expressing every fixture
 * as an offset keeps the expiry tests about expiry rather than about the date
 * this file was written.
 */
const NOW_MS = Date.now()
const HOUR = 60 * 60 * 1000

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: () => '__delete__', increment: (n: number) => ({ __increment: n }) },
  Timestamp: {
    now: () => ({ toMillis: () => NOW_MS, toDate: () => new Date(NOW_MS) }),
    fromMillis: (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms) }),
  },
}))

vi.mock('@/lib/firebase-admin', () => ({
  adminAuth: { verifySessionCookie: vi.fn() },
  adminDb: { doc: vi.fn(), collection: vi.fn(), collectionGroup: vi.fn(), batch: vi.fn(), runTransaction: vi.fn() },
}))

vi.mock('@/lib/stripe', () => ({
  stripe: { subscriptions: { update: mockSubscriptionsUpdate, retrieve: mockSubscriptionsRetrieve } },
}))

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }),
}))

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string): never => {
    throw new Error(`REDIRECT:${url}`)
  }),
}))

import { lookupCancelToken } from '@/lib/queries/companyDeletionCancel'
import { cancelCompanyDeletionByToken } from '@/actions/companyDeletion'
import { adminDb } from '@/lib/firebase-admin'

const TOKEN = 'abc123token'
const REQUEST_ID = 'req-1'
const COMPANY_ID = 'company-A'
const COMPANY_NAME = 'Rigg & Rep AB'

/** Firestore Timestamp-shaped value, as stored. */
function ts(ms: number) {
  return { toMillis: () => ms, toDate: () => new Date(ms) }
}

interface WireOptions {
  token?: Record<string, unknown> | null
  ledger?: Record<string, unknown> | null
  company?: Record<string, unknown> | null
}

function wire(opts: WireOptions = {}) {
  const docs: DocMap = {}

  docs[`companyDeletionCancelTokens/${TOKEN}`] =
    opts.token === null
      ? null
      : {
          requestId: REQUEST_ID,
          companyId: COMPANY_ID,
          createdAt: ts(NOW_MS - HOUR),
          expiresAt: ts(NOW_MS + 24 * HOUR),
          ...opts.token,
        }

  docs[`companyDeletions/${REQUEST_ID}`] =
    opts.ledger === null
      ? null
      : {
          requestId: REQUEST_ID,
          companyId: COMPANY_ID,
          companyName: COMPANY_NAME,
          state: 'requested',
          mode: 'window',
          requestedByName: 'Anna Admin',
          scheduledFor: ts(NOW_MS + 6 * 24 * HOUR),
          ...opts.ledger,
        }

  docs[`companies/${COMPANY_ID}`] =
    opts.company === null
      ? null
      : {
          name: COMPANY_NAME,
          deletion: { state: 'requested', requestId: REQUEST_ID, mode: 'window' },
          ...opts.company,
        }

  const query: QueryResolver = (ctx) =>
    ctx.path === `companies/${COMPANY_ID}/members`
      ? [{ id: 'a1', path: `companies/${COMPANY_ID}/members/a1`, data: { role: 'admin', email: 'a@example.com' } }]
      : []

  const wired = wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })
  const tx = makeTransaction(docs)
  vi.mocked(adminDb.runTransaction).mockImplementation(
    (cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx),
  )
  return { docs, tx, wired }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSubscriptionsUpdate.mockResolvedValue({})
  mockSubscriptionsRetrieve.mockResolvedValue({ status: 'active' })
})

describe('lookupCancelToken — rendering the page', () => {
  it('MUTATION GUARD: reading the page writes nothing and cancels nothing', async () => {
    // Mail scanners, link prefetchers and "safe links" rewriters fetch these
    // URLs with no human involved. A deletion stopped by a robot is exactly
    // as wrong as one executed by a robot — the whole reason a cancel link
    // is allowed to exist in an email is that it cannot do anything on its
    // own. Move the cancel into the page and this test fails.
    const { tx, wired } = wire()

    const result = await lookupCancelToken(TOKEN)

    expect(result.state).toBe('valid')
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
    expect(tx.update).not.toHaveBeenCalled()
    expect(tx.set).not.toHaveBeenCalled()
    expect(tx.delete).not.toHaveBeenCalled()
    expect(wired.batch.commit).not.toHaveBeenCalled()
  })

  it('valid token: reports the company, the date and who asked', async () => {
    wire()
    const result = await lookupCancelToken(TOKEN)
    expect(result).toMatchObject({
      state: 'valid',
      companyName: COMPANY_NAME,
      requestedByName: 'Anna Admin',
    })
    expect(result.scheduledFor).toBe(new Date(NOW_MS + 6 * 24 * HOUR).toISOString())
  })

  it('unknown token', async () => {
    wire({ token: null })
    expect((await lookupCancelToken(TOKEN)).state).toBe('unknown')
  })

  it('token pointing at a ledger that is gone is unknown, not an error', async () => {
    wire({ ledger: null })
    expect((await lookupCancelToken(TOKEN)).state).toBe('unknown')
  })

  it('used token', async () => {
    wire({ token: { usedAt: ts(NOW_MS - HOUR) } })
    expect((await lookupCancelToken(TOKEN)).state).toBe('used')
  })

  it('expired token', async () => {
    wire({ token: { expiresAt: ts(NOW_MS - HOUR) } })
    expect((await lookupCancelToken(TOKEN)).state).toBe('expired')
  })

  it('already cancelled is reported ahead of "used" — the visitor cares about the company, not the link', async () => {
    // A deletion cancelled by another admin leaves this link unspent, but
    // "your link is used up" would read as a failure when in fact the
    // visitor's goal is already met.
    wire({ ledger: { state: 'canceled' }, token: { usedAt: ts(NOW_MS - HOUR) } })
    expect((await lookupCancelToken(TOKEN)).state).toBe('already_canceled')
  })

  it('completed deletion: the company is gone', async () => {
    wire({ ledger: { state: 'completed' } })
    expect((await lookupCancelToken(TOKEN)).state).toBe('company_gone')
  })

  it('executing deletion: too late for this link', async () => {
    wire({ ledger: { state: 'executing' } })
    expect((await lookupCancelToken(TOKEN)).state).toBe('too_late')
  })

  it('company document already deleted while the ledger still says requested', async () => {
    wire({ company: null })
    expect((await lookupCancelToken(TOKEN)).state).toBe('company_gone')
  })

  it('empty token string', async () => {
    wire()
    expect((await lookupCancelToken('')).state).toBe('unknown')
  })
})

describe('cancelCompanyDeletionByToken — the button', () => {
  it('spends the token and clears the deletion in ONE transaction', async () => {
    // Both writes together or neither: two people clicking the same link at
    // the same second cannot produce two cancellations, and a cancellation
    // that fails cannot burn the token.
    const { tx } = wire()

    const result = await cancelCompanyDeletionByToken(TOKEN)

    expect(result.state).toBe('valid')
    expect(adminDb.runTransaction).toHaveBeenCalledOnce()

    const tokenUpdate = tx.update.mock.calls.find(
      ([ref]) => (ref as DocRefStub).path === `companyDeletionCancelTokens/${TOKEN}`,
    )
    expect(tokenUpdate![1]).toMatchObject({ usedAt: expect.anything() })

    const companyUpdate = tx.update.mock.calls.find(
      ([ref]) => (ref as DocRefStub).path === `companies/${COMPANY_ID}`,
    )
    expect(companyUpdate![1]).toEqual({ deletion: '__delete__' })

    const ledgerUpdate = tx.update.mock.calls.find(
      ([ref]) => (ref as DocRefStub).path === `companyDeletions/${REQUEST_ID}`,
    )
    expect(ledgerUpdate![1]).toMatchObject({ state: 'canceled', cancelSource: 'cancel_link' })
  })

  it('records no uid or email for a link cancellation — a bearer token names nobody', async () => {
    // The ledger is an audit trail that outlives the company. Attributing a
    // link click to a person would be a fabrication in it; `cancelSource`
    // carries the honest record instead.
    const { tx } = wire()
    await cancelCompanyDeletionByToken(TOKEN)
    const ledgerUpdate = tx.update.mock.calls.find(
      ([ref]) => (ref as DocRefStub).path === `companyDeletions/${REQUEST_ID}`,
    )!
    expect(ledgerUpdate[1]).not.toHaveProperty('canceledByUid')
    expect(ledgerUpdate[1]).not.toHaveProperty('canceledByEmail')
  })

  it('MUTATION GUARD: a token that has already been used cancels nothing a second time', async () => {
    const { tx } = wire({ token: { usedAt: ts(NOW_MS - HOUR) } })

    const result = await cancelCompanyDeletionByToken(TOKEN)

    expect(result.state).toBe('used')
    expect(tx.update).not.toHaveBeenCalled()
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled()
  })

  it('MUTATION GUARD: an expired token cancels nothing', async () => {
    const { tx } = wire({ token: { expiresAt: ts(NOW_MS - HOUR) } })
    const result = await cancelCompanyDeletionByToken(TOKEN)
    expect(result.state).toBe('expired')
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('an unknown token writes nothing', async () => {
    const { tx } = wire({ token: null })
    expect((await cancelCompanyDeletionByToken(TOKEN)).state).toBe('unknown')
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('refuses when the ledger and the company disagree about which request is live', async () => {
    // A ledger saying `requested` while the company points at a DIFFERENT
    // request means something is out of step. Writing "cancelled" on the
    // ledger while the company still carries a live deletion would make the
    // ledger lie, and the sweep would purge the company anyway.
    const { tx } = wire({
      company: { deletion: { state: 'requested', requestId: 'some-other-request' } },
    })

    const result = await cancelCompanyDeletionByToken(TOKEN)

    expect(result.state).toBe('too_late')
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('resumes billing and mails the admins after a successful cancellation', async () => {
    const { wired } = wire({ company: { subscription: { stripeSubscriptionId: 'sub_123' } } })

    await cancelCompanyDeletionByToken(TOKEN)

    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_123', { pause_collection: null })
    expect(wired.batch.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ template: 'companyDeletionCancelled', to: 'a@example.com' }),
    )
  })
})
