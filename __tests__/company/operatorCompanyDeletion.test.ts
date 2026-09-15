/**
 * `actions/operatorCompanyDeletion.ts` — issue #252 step 6, PR 5. The
 * operator view's three destructive/corrective moves on a company deletion:
 * cancel, request-on-behalf, requeue-a-failed-purge.
 *
 * Every test here is written to FAIL if a specific guard is removed, not
 * merely to describe the happy path — the three that matter most:
 *
 *   - cancel must work with ZERO admins present (the entire reason this
 *     view exists — see the design brief's "ingen admin kvar" case).
 *   - requeue must NOT reset `completedPhases` (that would redo already-
 *     finished, possibly destructive work).
 *   - every `operatorActions` entry must carry `byUid`/`byName` EXPLICITLY,
 *     never omitted — an omitted field reads back as `null`, i.e.
 *     "redacted by the 24-month retention job" (lib/operatorDeletionQueries.ts).
 *
 * Firebase Admin and Stripe are both mocked; no network calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { wireDb, makeTransaction, type DocMap, type DocRefStub } from '../helpers/firestore'

const { mockGetOperatorSession, mockSubscriptionsUpdate, mockSubscriptionsRetrieve } = vi.hoisted(() => ({
  mockGetOperatorSession: vi.fn(),
  mockSubscriptionsUpdate: vi.fn(),
  mockSubscriptionsRetrieve: vi.fn(),
}))

const NOW_MS = 1_760_000_000_000

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    delete: () => '__delete__',
  },
  Timestamp: {
    now: () => ({ toMillis: () => NOW_MS, toDate: () => new Date(NOW_MS) }),
    fromMillis: (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms) }),
  },
}))

vi.mock('@/lib/firebase-admin', () => ({
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

vi.mock('@/lib/operator-dal', () => ({
  getOperatorSession: mockGetOperatorSession,
  rethrowRedirect: (err: unknown) => {
    const digest = (err as { digest?: string })?.digest ?? ''
    const msg = err instanceof Error ? err.message : ''
    if (digest.startsWith('NEXT_REDIRECT') || msg.startsWith('REDIRECT:')) throw err
  },
}))

import {
  cancelCompanyDeletionAsOperator,
  requestCompanyDeletionAsOperator,
  requeueFailedCompanyDeletion,
} from '@/actions/operatorCompanyDeletion'
import { adminDb } from '@/lib/firebase-admin'

const OPERATOR_UID = 'operator-uid'
const OPERATOR_EMAIL = 'jocke@allocate.at'
const COMPANY_ID = 'company-A'
const COMPANY_NAME = 'Rigg & Rep AB'

function wireTx(docs: DocMap) {
  const wired = wireDb(adminDb as unknown as Record<string, unknown>, { docs })
  const tx = makeTransaction(docs)
  vi.mocked(adminDb.runTransaction).mockImplementation(
    (cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx),
  )
  return { tx, wired }
}

function ledgerUpdate(tx: ReturnType<typeof makeTransaction>, path: string) {
  return tx.update.mock.calls.find(([ref]) => (ref as DocRefStub).path === path)
}

function ledgerSet(tx: ReturnType<typeof makeTransaction>) {
  return tx.set.mock.calls.find(([ref]) => (ref as DocRefStub).path.startsWith('companyDeletions/'))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetOperatorSession.mockResolvedValue({ uid: OPERATOR_UID, email: OPERATOR_EMAIL })
  mockSubscriptionsUpdate.mockResolvedValue({})
  mockSubscriptionsRetrieve.mockResolvedValue({ status: 'active' })
})

describe('cancelCompanyDeletionAsOperator', () => {
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

  function wireCompany(opts: { deletion?: Record<string, unknown>; ledger?: Record<string, unknown> | null } = {}) {
    const docs: DocMap = {
      [`companies/${COMPANY_ID}`]: {
        name: COMPANY_NAME,
        ...(opts.deletion ? { deletion: opts.deletion } : {}),
      },
    }
    if (opts.ledger !== undefined && opts.ledger !== null) {
      docs[`companyDeletions/${(opts.deletion?.requestId as string) ?? 'req-1'}`] = opts.ledger
    }
    // MUTATION GUARD: no `companies/{cid}/members` doc is wired at all — this
    // is deliberate. If `cancelCompanyDeletionAsOperator` ever starts reading
    // membership (the mistake that would make it useless for exactly the
    // no-admin-left case it exists to serve), the missing query wiring would
    // make that read resolve empty rather than error, so this test would only
    // catch a REAL membership check via the assertions below — not via a
    // crash. The assertions are what matter.
    return wireTx(docs)
  }

  it('cancels a requested deletion with ZERO administrators in the company — the entire reason this action exists', async () => {
    const { tx } = wireCompany({ deletion: PENDING, ledger: LEDGER })

    const result = await cancelCompanyDeletionAsOperator(COMPANY_ID, 'ticket #123')

    expect(result.error).toBeUndefined()
    expect(result.ok).toBe(true)

    const companyUpdate = tx.update.mock.calls.find(([ref]) => (ref as DocRefStub).path === `companies/${COMPANY_ID}`)
    expect(companyUpdate![1]).toEqual({ deletion: '__delete__' })

    const update = ledgerUpdate(tx, 'companyDeletions/req-1')
    expect(update![1]).toMatchObject({ state: 'canceled', cancelSource: 'operator' })
  })

  it('always sets byUid and byName on the operatorActions entry — never omits them', async () => {
    const { tx } = wireCompany({ deletion: PENDING, ledger: LEDGER })

    await cancelCompanyDeletionAsOperator(COMPANY_ID, '')

    const update = ledgerUpdate(tx, 'companyDeletions/req-1')
    const actions = (update![1] as { operatorActions: Array<Record<string, unknown>> }).operatorActions
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ action: 'cancel', byUid: OPERATOR_UID, byName: OPERATOR_EMAIL })
    expect(actions[0].byUid).not.toBeUndefined()
    expect(actions[0].byName).not.toBeUndefined()
    // No note given — must be OMITTED, not written as '' or null (matches
    // the optional `note?` field's contract elsewhere in this codebase).
    expect('note' in actions[0]).toBe(false)
  })

  it('records the note when one is given', async () => {
    const { tx } = wireCompany({ deletion: PENDING, ledger: LEDGER })
    await cancelCompanyDeletionAsOperator(COMPANY_ID, '  ticket #123  ')
    const update = ledgerUpdate(tx, 'companyDeletions/req-1')
    const actions = (update![1] as { operatorActions: Array<Record<string, unknown>> }).operatorActions
    expect(actions[0].note).toBe('ticket #123')
  })

  it('preserves prior operatorActions entries rather than overwriting the array', async () => {
    const priorAction = { action: 'requeue', byUid: 'op-2', byName: 'other@allocate.at', at: '2026-01-01T00:00:00.000Z' }
    const { tx } = wireCompany({ deletion: PENDING, ledger: { ...LEDGER, operatorActions: [priorAction] } })

    await cancelCompanyDeletionAsOperator(COMPANY_ID, '')

    const update = ledgerUpdate(tx, 'companyDeletions/req-1')
    const actions = (update![1] as { operatorActions: Array<Record<string, unknown>> }).operatorActions
    expect(actions).toHaveLength(2)
    expect(actions[0]).toEqual(priorAction)
    expect(actions[1]).toMatchObject({ action: 'cancel' })
  })

  it('refuses to cancel a deletion that is already executing — cancelling can no longer honestly claim nothing happened', async () => {
    const { tx } = wireCompany({ deletion: { ...PENDING, state: 'executing' }, ledger: LEDGER })
    const result = await cancelCompanyDeletionAsOperator(COMPANY_ID, '')
    expect(result.error).toContain('already started')
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('refuses to cancel a FAILED deletion too — same reasoning as executing', async () => {
    const { tx } = wireCompany({ deletion: { ...PENDING, state: 'failed' }, ledger: LEDGER })
    const result = await cancelCompanyDeletionAsOperator(COMPANY_ID, '')
    expect(result.error).toContain('already started')
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('reports success when there was nothing to cancel', async () => {
    wireCompany({})
    const result = await cancelCompanyDeletionAsOperator(COMPANY_ID, '')
    expect(result.error).toBeUndefined()
    expect(result.nothingToCancel).toBe(true)
  })

  it('refuses when the company itself no longer exists', async () => {
    const wired = wireTx({})
    const result = await cancelCompanyDeletionAsOperator(COMPANY_ID, '')
    expect(result.error).toContain('no longer exists')
    void wired
  })

  it('resumes Stripe collection on cancel, same as the customer-facing path', async () => {
    const docs: DocMap = {
      [`companies/${COMPANY_ID}`]: { name: COMPANY_NAME, deletion: PENDING, subscription: { stripeSubscriptionId: 'sub_123' } },
      'companyDeletions/req-1': LEDGER,
    }
    wireTx(docs)
    await cancelCompanyDeletionAsOperator(COMPANY_ID, '')
    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_123', { pause_collection: null })
  })
})

describe('requestCompanyDeletionAsOperator', () => {
  function wireCompany(opts: { name?: string; deletion?: Record<string, unknown> } = {}) {
    const docs: DocMap = {
      [`companies/${COMPANY_ID}`]: {
        name: opts.name ?? COMPANY_NAME,
        ...(opts.deletion ? { deletion: opts.deletion } : {}),
      },
    }
    return wireTx(docs)
  }

  it('ALWAYS writes mode "window" — never derives it from anything', async () => {
    const { tx } = wireCompany()
    const result = await requestCompanyDeletionAsOperator(COMPANY_ID, COMPANY_NAME, 'customer asked via support, ticket #45')

    expect(result.error).toBeUndefined()
    const write = ledgerSet(tx)
    expect(write).toBeDefined()
    expect(write![1]).toMatchObject({ mode: 'window', state: 'requested', companyId: COMPANY_ID })

    const scheduled = (write![1] as { scheduledFor: { toMillis: () => number } }).scheduledFor
    expect(scheduled.toMillis() - NOW_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('records the operator as the requester, AND carries the reason in operatorActions', async () => {
    const { tx } = wireCompany()
    await requestCompanyDeletionAsOperator(COMPANY_ID, COMPANY_NAME, 'customer asked via support, ticket #45')

    const write = ledgerSet(tx)
    expect(write![1]).toMatchObject({
      requestedByUid: OPERATOR_UID,
      requestedByName: OPERATOR_EMAIL,
      requestedByEmail: OPERATOR_EMAIL,
    })
    const actions = (write![1] as { operatorActions: Array<Record<string, unknown>> }).operatorActions
    expect(actions).toEqual([
      expect.objectContaining({ action: 'request', byUid: OPERATOR_UID, byName: OPERATOR_EMAIL, note: 'customer asked via support, ticket #45' }),
    ])
  })

  it('refuses when the typed confirmation does not match the company name', async () => {
    const { tx } = wireCompany()
    const result = await requestCompanyDeletionAsOperator(COMPANY_ID, 'DELETE', '')
    expect(result.error).toContain('type its name exactly')
    expect(ledgerSet(tx)).toBeUndefined()
  })

  it('refuses when the company no longer exists', async () => {
    wireTx({})
    const result = await requestCompanyDeletionAsOperator(COMPANY_ID, COMPANY_NAME, '')
    expect(result.error).toContain('no longer exists')
  })

  it('returns the EXISTING scheduledFor, unchanged, when a deletion is already pending — never extends the window', async () => {
    const existingScheduledFor = { toDate: () => new Date(NOW_MS + 999) }
    const { tx } = wireCompany({
      deletion: { state: 'requested', requestId: 'req-existing', mode: 'window', scheduledFor: existingScheduledFor },
    })

    const result = await requestCompanyDeletionAsOperator(COMPANY_ID, COMPANY_NAME, '')

    expect(result.error).toBeUndefined()
    expect(result.alreadyRequested).toBe(true)
    expect(result.scheduledFor).toBe(new Date(NOW_MS + 999).toISOString())
    expect(ledgerSet(tx)).toBeUndefined()
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled()
  })

  it('pauses Stripe collection, same as the customer-facing path', async () => {
    const docs: DocMap = { [`companies/${COMPANY_ID}`]: { name: COMPANY_NAME, subscription: { stripeSubscriptionId: 'sub_1' } } }
    wireTx(docs)
    await requestCompanyDeletionAsOperator(COMPANY_ID, COMPANY_NAME, '')
    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_1', { pause_collection: { behavior: 'void' } })
  })
})

describe('requeueFailedCompanyDeletion', () => {
  const FAILED_LEDGER = {
    requestId: 'req-1',
    companyId: COMPANY_ID,
    state: 'failed',
    attempts: 5,
    completedPhases: ['stripe', 'invitations', 'members'],
    phase: 'subtree',
    lastError: 'recursiveDelete timed out',
  }

  function wireLedger(ledger: Record<string, unknown> | null) {
    const docs: DocMap = ledger ? { 'companyDeletions/req-1': ledger } : {}
    return wireTx(docs)
  }

  it('does NOT reset completedPhases, phase, or phaseCounts — a requeue is a resume, not a restart', async () => {
    const { tx } = wireLedger(FAILED_LEDGER)

    const result = await requeueFailedCompanyDeletion('req-1', 'retry after fixing the timeout')

    expect(result.error).toBeUndefined()
    const update = ledgerUpdate(tx, 'companyDeletions/req-1')
    expect(update).toBeDefined()
    const written = update![1] as Record<string, unknown>
    expect(written).not.toHaveProperty('completedPhases')
    expect(written).not.toHaveProperty('phase')
    expect(written).not.toHaveProperty('phaseCounts')
  })

  it('resets state to executing and attempts to 0 — the exact two fields the sweep needs to pick it up again', async () => {
    const { tx } = wireLedger(FAILED_LEDGER)
    await requeueFailedCompanyDeletion('req-1', '')
    const update = ledgerUpdate(tx, 'companyDeletions/req-1')
    expect(update![1]).toMatchObject({ state: 'executing', attempts: 0 })
  })

  it('backdates lastHeartbeatAt so the very next sweep tick treats it as stale and picks it up', async () => {
    const { tx } = wireLedger(FAILED_LEDGER)
    await requeueFailedCompanyDeletion('req-1', '')
    const update = ledgerUpdate(tx, 'companyDeletions/req-1')
    const heartbeat = (update![1] as { lastHeartbeatAt: { toMillis: () => number } }).lastHeartbeatAt
    // 60 minutes is the sweep's STALE_LEASE_MS bar (functions/src/company/sweep.ts) —
    // the backdated heartbeat must be older than that, comfortably.
    expect(NOW_MS - heartbeat.toMillis()).toBeGreaterThan(60 * 60 * 1000)
  })

  it('appends an operatorActions entry with byUid/byName always set', async () => {
    const { tx } = wireLedger(FAILED_LEDGER)
    await requeueFailedCompanyDeletion('req-1', 'ticket #99')
    const update = ledgerUpdate(tx, 'companyDeletions/req-1')
    const actions = (update![1] as { operatorActions: Array<Record<string, unknown>> }).operatorActions
    expect(actions).toEqual([
      expect.objectContaining({ action: 'requeue', byUid: OPERATOR_UID, byName: OPERATOR_EMAIL, note: 'ticket #99' }),
    ])
  })

  it('refuses to requeue anything that is not failed', async () => {
    const { tx } = wireLedger({ ...FAILED_LEDGER, state: 'executing' })
    const result = await requeueFailedCompanyDeletion('req-1', '')
    expect(result.error).toContain('Only a failed deletion')
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('refuses a requestId that does not exist', async () => {
    wireLedger(null)
    const result = await requeueFailedCompanyDeletion('req-1', '')
    expect(result.error).toContain('could not be found')
  })
})
