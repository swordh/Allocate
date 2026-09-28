/**
 * `actions/submitFeedback.ts` — issue #424 (shared sequential ticket counter).
 *
 * Covers the `adminDb.runTransaction` allocation of `counters/operatorFeedback`
 * (`{ next: number }`, default `TICKET_NUMBER_START` when missing): the id is
 * written via `tx.create`, never `tx.set` or a non-transactional `.set()`, so a
 * bug here fails loudly (ALREADY_EXISTS) instead of silently overwriting
 * another user's ticket — see the action's own docblock for why that matters
 * for `notes` subcollections and `purgeOldFeedback`'s `closedAt` sweep.
 *
 * Firebase Admin is mocked; no network calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetVerifiedSession } = vi.hoisted(() => ({
  mockGetVerifiedSession: vi.fn(),
}))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__serverTimestamp__',
  },
}))

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {
    doc: vi.fn(),
    collection: vi.fn(),
    runTransaction: vi.fn(),
  },
}))

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: mockGetVerifiedSession,
}))

import { submitFeedback } from '@/actions/submitFeedback'
import { adminDb } from '@/lib/firebase-admin'

const UID = 'user-1'
const COMPANY_ID = 'company-1'
const SESSION = { uid: UID, activeCompanyId: COMPANY_ID, email: 'test@example.com' }

const VALID_INPUT = { type: 'bug_report' as const, title: 'Something broke', description: 'It broke when I clicked.' }

/** A fake counter ref, distinguishable in tx.set/tx.create call assertions. */
const COUNTER_REF = { path: 'counters/operatorFeedback', id: 'operatorFeedback' }

function makeTicketRef(id: string) {
  return { path: `operatorFeedback/${id}`, id }
}

/**
 * Wires adminDb for a happy-path submit: doc()/collection() resolve to refs
 * whose identity we can assert on, and runTransaction invokes the callback
 * with a fake tx whose get() answers `counterNext` for the counter doc.
 */
function wire(counterNext: number | undefined) {
  const docFn = vi.fn((path: string) => {
    if (path === 'counters/operatorFeedback') return COUNTER_REF
    if (path === `users/${UID}`) return { get: vi.fn().mockResolvedValue({ data: () => ({ name: 'Test User' }) }) }
    if (path === `companies/${COMPANY_ID}`) return { get: vi.fn().mockResolvedValue({ data: () => ({ name: 'Test Co' }) }) }
    return { get: vi.fn().mockResolvedValue({ data: () => undefined }) }
  })
  const ticketDocFn = vi.fn((id: string) => makeTicketRef(id))
  const collectionFn = vi.fn((name: string) => {
    if (name === 'operatorFeedback') return { doc: ticketDocFn }
    throw new Error(`unexpected collection: ${name}`)
  })

  const tx = {
    get: vi.fn().mockResolvedValue({ data: () => (counterNext === undefined ? undefined : { next: counterNext }) }),
    set: vi.fn(),
    create: vi.fn(),
  }

  vi.mocked(adminDb.doc).mockImplementation(docFn as unknown as typeof adminDb.doc)
  vi.mocked(adminDb.collection).mockImplementation(collectionFn as unknown as typeof adminDb.collection)
  vi.mocked(adminDb.runTransaction).mockImplementation(
    (cb: (tx: unknown) => unknown) => cb(tx) as never,
  )

  return { tx, ticketDocFn, collectionFn }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetVerifiedSession.mockResolvedValue(SESSION)
})

describe('submitFeedback — ticket counter (#424)', () => {
  it('allocates BUG-10000 when the counter doc is missing, and advances it to 10001', async () => {
    const { tx, ticketDocFn } = wire(undefined)

    const result = await submitFeedback(VALID_INPUT)

    expect(result).toEqual({ ticketId: 'BUG-10000' })
    expect(ticketDocFn).toHaveBeenCalledWith('BUG-10000')
    expect(tx.set).toHaveBeenCalledWith(COUNTER_REF, { next: 10001 })
  })

  it('uses the existing counter value and the prefix for feature_request (FEA-10042)', async () => {
    wire(10042)

    const result = await submitFeedback({ ...VALID_INPUT, type: 'feature_request' })

    expect(result).toEqual({ ticketId: 'FEA-10042' })
  })

  it('uses the same shared counter value for support (SUP-10042) — prefix comes from type only', async () => {
    wire(10042)

    const result = await submitFeedback({ ...VALID_INPUT, type: 'support' })

    expect(result).toEqual({ ticketId: 'SUP-10042' })
  })

  it('writes the ticket via tx.create, never tx.set — tx.set is only ever called for the counter ref', async () => {
    const { tx } = wire(10042)

    await submitFeedback(VALID_INPUT)

    expect(tx.create).toHaveBeenCalledTimes(1)
    expect(tx.create).toHaveBeenCalledWith(makeTicketRef('BUG-10042'), expect.objectContaining({ type: 'bug_report' }))
    expect(tx.set).toHaveBeenCalledTimes(1)
    expect(tx.set).toHaveBeenCalledWith(COUNTER_REF, expect.anything())
  })

  it('reads the counter (tx.get) before writing either the counter or the ticket', async () => {
    const { tx } = wire(10042)

    await submitFeedback(VALID_INPUT)

    const getOrder = tx.get.mock.invocationCallOrder[0]
    const setOrder = tx.set.mock.invocationCallOrder[0]
    const createOrder = tx.create.mock.invocationCallOrder[0]

    expect(getOrder).toBeLessThan(setOrder)
    expect(getOrder).toBeLessThan(createOrder)
  })

  it('returns a generic error, without throwing, when tx.create hits ALREADY_EXISTS (code 6)', async () => {
    const { tx } = wire(10042)
    tx.create.mockImplementation(() => {
      throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 })
    })

    const result = await submitFeedback(VALID_INPUT)

    expect(result).toEqual({ error: 'Failed to submit. Please try again.' })
  })

  it('rejects an invalid feedback type without ever starting a transaction', async () => {
    wire(10042)

    const result = await submitFeedback({ ...VALID_INPUT, type: 'not_a_real_type' as unknown as typeof VALID_INPUT.type })

    expect(result).toEqual({ error: 'Invalid type' })
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
  })
})
