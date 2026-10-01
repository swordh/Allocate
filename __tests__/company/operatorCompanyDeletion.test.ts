/**
 * `actions/operatorCompanyDeletion.ts` — issue #252 step 6, PR 5, plus issue
 * #331/#335's fourth move. The operator view's four destructive/corrective
 * moves on a company deletion: cancel, request-on-behalf,
 * requeue-a-failed-purge, mark-a-stuck-purge-failed.
 *
 * Every test here is written to FAIL if a specific guard is removed, not
 * merely to describe the happy path — the ones that matter most:
 *
 *   - cancel must work with ZERO admins present (the entire reason this
 *     view exists — see the design brief's "ingen admin kvar" case).
 *   - requeue must NOT reset `completedPhases` (that would redo already-
 *     finished, possibly destructive work).
 *   - requeue must refuse a row whose contacts have already been redacted.
 *   - mark-failed must refuse anything not `executing`, and anything whose
 *     heartbeat isn't actually stale yet.
 *   - every `operatorActions` entry must carry `byUid`/`byName` EXPLICITLY,
 *     never omitted — an omitted field reads back as `null`, i.e.
 *     "redacted by the 24-month retention job" (lib/operatorDeletionQueries.ts).
 *
 * Firebase Admin and Stripe are both mocked; no network calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { wireDb, makeTransaction, queryFor, filterValue, type DocMap, type DocRefStub, type QueryResolver } from '../helpers/firestore'

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
  markStuckCompanyDeletionFailed,
} from '@/actions/operatorCompanyDeletion'
import { adminDb } from '@/lib/firebase-admin'

const OPERATOR_UID = 'operator-uid'
const OPERATOR_EMAIL = 'jocke@allocate.at'
const COMPANY_ID = 'company-A'
const COMPANY_NAME = 'Rigg & Rep AB'

function wireTx(docs: DocMap, query?: QueryResolver) {
  const wired = wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })
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

  // ── issue #334 follow-up review fix ───────────────────────────────────────
  //
  // `cancelCompanyDeletionAsOperator` shares `finishCancellation`
  // (lib/companyDeletionCancelWrites.ts) with the two customer-facing cancel
  // paths, and that function queues the `companyDeletionCancelled` mail
  // straight from its `cancelledByName` PARAMETER — not from the ledger's
  // `canceledByName` this action just wrote. Before this fix, the call site
  // passed `session.email` (the operator's own address) into that parameter,
  // so every admin on the company would see the operator's raw email in the
  // "STOPPED BY" row. The LEDGER write (`canceledByName`/`canceledByEmail`,
  // asserted separately above) must stay the real identity; only the MAIL
  // must not.
  it('queues companyDeletionCancelled mail with the support display string, never the operator email', async () => {
    const oneAdmin = queryFor(
      (ctx) => ctx.path === `companies/${COMPANY_ID}/members` && filterValue(ctx, 'role') === 'admin',
      [{ id: 'member-1', data: { email: 'admin@rigg.se', role: 'admin' } }],
    )
    const docs: DocMap = {
      [`companies/${COMPANY_ID}`]: { name: COMPANY_NAME, deletion: PENDING },
      'companyDeletions/req-1': LEDGER,
    }
    const wired = wireDb(adminDb as unknown as Record<string, unknown>, { docs, query: oneAdmin })
    const tx = makeTransaction(docs)
    vi.mocked(adminDb.runTransaction).mockImplementation((cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx))

    const result = await cancelCompanyDeletionAsOperator(COMPANY_ID, '')
    expect(result.error).toBeUndefined()

    // `finishCancellation` queues its mail through `adminDb.batch()`, not
    // through the transaction — a plain `WriteBatch`, separate from `tx`.
    expect(wired.batch.set).toHaveBeenCalled()
    const mailCall = wired.batch.set.mock.calls[0]
    expect(mailCall).toBeDefined()
    const mailData = mailCall![1] as { template: string; to: string; data: Record<string, unknown> }
    expect(mailData.template).toBe('companyDeletionCancelled')
    expect(mailData.to).toBe('admin@rigg.se')
    expect(mailData.data.cancelledByName).toBe('Allocate support (support@allocate.at)')
    expect(mailData.data.cancelledByName).not.toBe(OPERATOR_EMAIL)
    expect(JSON.stringify(mailData)).not.toContain(OPERATOR_EMAIL)

    // The ledger write itself is unaffected — still the operator's real
    // identity, for the audit trail.
    const ledgerWrite = ledgerUpdate(tx, 'companyDeletions/req-1')
    expect(ledgerWrite![1]).toMatchObject({ canceledByName: OPERATOR_EMAIL, canceledByEmail: OPERATOR_EMAIL })
  })
})

describe('requestCompanyDeletionAsOperator', () => {
  function wireCompany(
    opts: { name?: string; deletion?: Record<string, unknown>; timezone?: string } = {},
  ) {
    const docs: DocMap = {
      [`companies/${COMPANY_ID}`]: {
        name: opts.name ?? COMPANY_NAME,
        ...(opts.deletion ? { deletion: opts.deletion } : {}),
        ...(opts.timezone ? { preferences: { timezone: opts.timezone } } : {}),
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

  // ── issue #334 — requestSource ────────────────────────────────────────────
  it('writes requestSource "operator" on BOTH the ledger and the company mirror', async () => {
    const { tx } = wireCompany()
    await requestCompanyDeletionAsOperator(COMPANY_ID, COMPANY_NAME, '')

    const write = ledgerSet(tx)
    expect(write![1]).toMatchObject({ requestSource: 'operator' })

    const companyUpdate = tx.update.mock.calls.find(([ref]) => (ref as DocRefStub).path === `companies/${COMPANY_ID}`)
    const deletionMirror = (companyUpdate![1] as { deletion: Record<string, unknown> }).deletion
    expect(deletionMirror).toMatchObject({ requestSource: 'operator' })
  })

  // ── issue #334 follow-up review fix ───────────────────────────────────────
  //
  // `companies/{cid}.deletion` is the MEMBER-READABLE mirror —
  // firestore.rules lets every member of the company read `companies/{cid}`
  // directly over the client SDK, regardless of which UI component (or
  // display helper) later reads that field. Writing the operator's raw
  // email into `requestedByName` here would leak it to every member no
  // matter how `CompanySettingsForm`/`lib/subscription-state.ts` format it
  // on the way out — the LEDGER's own `requestedByName` (asserted as
  // `OPERATOR_EMAIL` two tests up) is where the real identity belongs,
  // because `companyDeletions/{requestId}` has no client read rule at all.
  it('writes the support display string into the MIRROR\'s requestedByName — never the operator email, which a client can read directly', async () => {
    const { tx } = wireCompany()
    await requestCompanyDeletionAsOperator(COMPANY_ID, COMPANY_NAME, '')

    const companyUpdate = tx.update.mock.calls.find(([ref]) => (ref as DocRefStub).path === `companies/${COMPANY_ID}`)
    const deletionMirror = (companyUpdate![1] as { deletion: Record<string, unknown> }).deletion
    expect(deletionMirror.requestedByName).toBe('Allocate support (support@allocate.at)')
    expect(deletionMirror.requestedByName).not.toBe(OPERATOR_EMAIL)
    expect(JSON.stringify(deletionMirror)).not.toContain(OPERATOR_EMAIL)

    // The ledger write is UNAFFECTED — still the operator's real identity.
    const ledgerWrite = ledgerSet(tx)
    expect(ledgerWrite![1]).toMatchObject({ requestedByName: OPERATOR_EMAIL, requestedByEmail: OPERATOR_EMAIL })
  })

  // ── issue #361 — timezone snapshot ────────────────────────────────────────
  it('snapshots the company preferences.timezone onto the ledger at request time', async () => {
    const { tx } = wireCompany({ timezone: 'Europe/Stockholm' })
    await requestCompanyDeletionAsOperator(COMPANY_ID, COMPANY_NAME, '')
    const write = ledgerSet(tx)
    expect(write![1]).toMatchObject({ timezone: 'Europe/Stockholm' })
  })

  it('falls back to UTC when the company has no timezone preference set', async () => {
    const { tx } = wireCompany()
    await requestCompanyDeletionAsOperator(COMPANY_ID, COMPANY_NAME, '')
    const write = ledgerSet(tx)
    expect(write![1]).toMatchObject({ timezone: 'UTC' })
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

  it('refuses to requeue a row whose contacts have already been redacted', async () => {
    const { tx } = wireLedger({ ...FAILED_LEDGER, contactsRedactedAt: '2026-01-01T00:00:00.000Z' })
    const result = await requeueFailedCompanyDeletion('req-1', '')
    expect(result.error).toContain('redacted')
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('flips the mirror back to executing when the company still exists and requestId matches', async () => {
    const docs: DocMap = {
      'companyDeletions/req-1': FAILED_LEDGER,
      [`companies/${COMPANY_ID}`]: { name: COMPANY_NAME, deletion: { state: 'failed', requestId: 'req-1' } },
    }
    const { tx } = wireTx(docs)
    await requeueFailedCompanyDeletion('req-1', '')
    const companyUpdate = tx.update.mock.calls.find(([ref]) => (ref as DocRefStub).path === `companies/${COMPANY_ID}`)
    expect(companyUpdate![1]).toEqual({ 'deletion.state': 'executing' })
  })

  it('does NOT touch the mirror when the company no longer exists', async () => {
    const { tx } = wireLedger(FAILED_LEDGER)
    await requeueFailedCompanyDeletion('req-1', '')
    const companyUpdate = tx.update.mock.calls.find(([ref]) => (ref as DocRefStub).path === `companies/${COMPANY_ID}`)
    expect(companyUpdate).toBeUndefined()
  })

  it('does NOT touch the mirror when a newer request has overwritten it', async () => {
    const docs: DocMap = {
      'companyDeletions/req-1': FAILED_LEDGER,
      [`companies/${COMPANY_ID}`]: { name: COMPANY_NAME, deletion: { state: 'requested', requestId: 'req-newer' } },
    }
    const { tx } = wireTx(docs)
    await requeueFailedCompanyDeletion('req-1', '')
    const companyUpdate = tx.update.mock.calls.find(([ref]) => (ref as DocRefStub).path === `companies/${COMPANY_ID}`)
    expect(companyUpdate).toBeUndefined()
  })

  it('resets the no-progress baselines and clears failureReason/failedAt, keeping failedNotifiedAt', async () => {
    const { tx } = wireLedger({
      ...FAILED_LEDGER,
      progressUnits: 42,
      leaseProgressUnits: 40,
      leaseAttempts: 4,
      noProgressResumes: 3,
      failureReason: 'attempts_exhausted',
      failedAt: '2026-01-01T00:00:00.000Z',
      failedNotifiedAt: '2026-01-01T00:00:00.000Z',
    })
    await requeueFailedCompanyDeletion('req-1', '')
    const update = ledgerUpdate(tx, 'companyDeletions/req-1')
    expect(update![1]).toMatchObject({
      noProgressResumes: 0,
      leaseAttempts: 0,
      leaseProgressUnits: 42,
      failureReason: '__delete__',
      failedAt: '__delete__',
    })
    expect(update![1]).not.toHaveProperty('failedNotifiedAt')
  })
})

describe('markStuckCompanyDeletionFailed', () => {
  const STALE_HEARTBEAT_ISO = new Date(NOW_MS - 90 * 60 * 1000).toISOString() // 90 min ago > 60 min bar
  const FRESH_HEARTBEAT_ISO = new Date(NOW_MS - 5 * 60 * 1000).toISOString() // 5 min ago

  const EXECUTING_LEDGER = {
    requestId: 'req-1',
    companyId: COMPANY_ID,
    companyName: COMPANY_NAME,
    state: 'executing',
    mode: 'window',
    attempts: 0,
    lastHeartbeatAt: STALE_HEARTBEAT_ISO,
  }

  function noAdmins(): QueryResolver {
    return () => []
  }

  function oneAdmin(email: string): QueryResolver {
    return queryFor(
      (ctx) => ctx.path === `companies/${COMPANY_ID}/members` && filterValue(ctx, 'role') === 'admin',
      [{ id: 'member-1', data: { email, role: 'admin' } }],
    )
  }

  function wire(ledger: Record<string, unknown> | null, opts: { company?: Record<string, unknown>; query?: QueryResolver } = {}) {
    const docs: DocMap = {}
    if (ledger) docs['companyDeletions/req-1'] = ledger
    if (opts.company) docs[`companies/${COMPANY_ID}`] = opts.company
    return wireTx(docs, opts.query ?? noAdmins())
  }

  it('marks an executing, stuck deletion as failed — ledger, mirror and mail all written like the automatic path', async () => {
    const { tx } = wire(EXECUTING_LEDGER, {
      company: { name: COMPANY_NAME, deletion: { state: 'executing', requestId: 'req-1' } },
      query: oneAdmin('admin@rigg.se'),
    })

    const result = await markStuckCompanyDeletionFailed('req-1', 'confirmed stuck via support ticket #7')

    expect(result.error).toBeUndefined()
    expect(result.ok).toBe(true)

    const ledgerUpdates = tx.update.mock.calls.filter(([ref]) => (ref as DocRefStub).path === 'companyDeletions/req-1')
    // Two separate tx.update calls land on the ledger: this action's own
    // operatorActions write, and applyFailedTransitionNext's failure write —
    // exactly the same "two updates, same doc, same transaction" pattern
    // purge.ts's catch block uses when it calls applyFailedTransition itself.
    expect(ledgerUpdates.length).toBeGreaterThanOrEqual(2)
    const failureWrite = ledgerUpdates.find(([, data]) => (data as Record<string, unknown>).state === 'failed')
    expect(failureWrite![1]).toMatchObject({ state: 'failed', failureReason: 'operator' })

    const actionsWrite = ledgerUpdates.find(([, data]) => 'operatorActions' in (data as Record<string, unknown>))
    const actions = (actionsWrite![1] as { operatorActions: Array<Record<string, unknown>> }).operatorActions
    expect(actions[0]).toMatchObject({ action: 'mark_failed', byUid: OPERATOR_UID, byName: OPERATOR_EMAIL })

    const companyUpdate = tx.update.mock.calls.find(([ref]) => (ref as DocRefStub).path === `companies/${COMPANY_ID}`)
    expect(companyUpdate![1]).toEqual({ 'deletion.state': 'failed' })

    const mailSet = tx.set.mock.calls.find(([ref]) => (ref as DocRefStub).path.startsWith('mail/'))
    expect(mailSet![1]).toMatchObject({ to: 'admin@rigg.se', template: 'companyDeletionFailed' })
  })

  it('does NOT touch attempts — this is not a failed purge attempt', async () => {
    const { tx } = wire({ ...EXECUTING_LEDGER, attempts: 2 })
    await markStuckCompanyDeletionFailed('req-1', '')
    const ledgerUpdates = tx.update.mock.calls.filter(([ref]) => (ref as DocRefStub).path === 'companyDeletions/req-1')
    for (const [, data] of ledgerUpdates) {
      expect(data as Record<string, unknown>).not.toHaveProperty('attempts')
    }
  })

  it('refuses a deletion that is not executing', async () => {
    const { tx } = wire({ ...EXECUTING_LEDGER, state: 'requested' })
    const result = await markStuckCompanyDeletionFailed('req-1', '')
    expect(result.error).toContain('currently executing')
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('refuses a deletion whose heartbeat is not actually stale yet', async () => {
    const { tx } = wire({ ...EXECUTING_LEDGER, lastHeartbeatAt: FRESH_HEARTBEAT_ISO })
    const result = await markStuckCompanyDeletionFailed('req-1', '')
    expect(result.error).toContain('minute')
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('refuses a deletion that has never heartbeated at all', async () => {
    const { tx } = wire({ ...EXECUTING_LEDGER, lastHeartbeatAt: undefined })
    const result = await markStuckCompanyDeletionFailed('req-1', '')
    expect(result.error).toContain('no heartbeat')
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('refuses a requestId that does not exist', async () => {
    wire(null)
    const result = await markStuckCompanyDeletionFailed('req-1', '')
    expect(result.error).toContain('could not be found')
  })
})

// ── Review fix: id validation + note length cap ─────────────────────────────
//
// Every action below builds a Firestore document path directly from a
// client-supplied `companyId`/`requestId` argument (a server action is its
// own public endpoint — see this file's own "Security, shared by all three"
// docblock, and `proxy.ts` never validates these). A value containing a `/`
// would otherwise let the path resolve somewhere outside the single
// company/ledger document this action is supposed to be confined to. These
// tests assert the REJECTION happens before any transaction is even
// attempted (no wasted read, no information about why it failed beyond the
// ordinary "not found" a caller already gets for a genuinely missing id) —
// not just that SOME error comes back.
describe('operator action input validation (review fix)', () => {
  const MALFORMED_IDS = [
    'a/b', // path traversal into an unrelated collection
    '../mail/x',
    '', // empty
    'x'.repeat(129), // over the 128-char cap
  ]

  describe('companyId', () => {
    for (const badId of MALFORMED_IDS) {
      it(`cancelCompanyDeletionAsOperator refuses companyId ${JSON.stringify(badId)} without touching Firestore`, async () => {
        const result = await cancelCompanyDeletionAsOperator(badId, '')
        expect(result.error).toContain('no longer exists')
        expect(adminDb.runTransaction).not.toHaveBeenCalled()
      })

      it(`requestCompanyDeletionAsOperator refuses companyId ${JSON.stringify(badId)} without touching Firestore`, async () => {
        const result = await requestCompanyDeletionAsOperator(badId, COMPANY_NAME, '')
        expect(result.error).toContain('no longer exists')
        expect(adminDb.runTransaction).not.toHaveBeenCalled()
      })
    }

    it('accepts an ordinary Firestore auto-id shaped companyId (does not false-positive)', async () => {
      const docs: DocMap = {
        [`companies/valid-Company_id-123`]: {
          name: COMPANY_NAME,
          deletion: {
            state: 'requested',
            requestId: 'req-1',
            scheduledFor: { toDate: () => new Date(NOW_MS + 1000) },
          },
        },
        'companyDeletions/req-1': {
          requestId: 'req-1',
          companyId: 'valid-Company_id-123',
          companyName: COMPANY_NAME,
          state: 'requested',
          scheduledFor: { toDate: () => new Date(NOW_MS + 1000) },
        },
      }
      wireTx(docs)
      const result = await cancelCompanyDeletionAsOperator('valid-Company_id-123', '')
      expect(result.error).toBeUndefined()
      expect(adminDb.runTransaction).toHaveBeenCalled()
    })
  })

  describe('requestId', () => {
    for (const badId of MALFORMED_IDS) {
      it(`requeueFailedCompanyDeletion refuses requestId ${JSON.stringify(badId)} without touching Firestore`, async () => {
        const result = await requeueFailedCompanyDeletion(badId, '')
        expect(result.error).toContain('could not be found')
        expect(adminDb.runTransaction).not.toHaveBeenCalled()
      })

      it(`markStuckCompanyDeletionFailed refuses requestId ${JSON.stringify(badId)} without touching Firestore`, async () => {
        const result = await markStuckCompanyDeletionFailed(badId, '')
        expect(result.error).toContain('could not be found')
        expect(adminDb.runTransaction).not.toHaveBeenCalled()
      })
    }
  })

  describe('note length cap', () => {
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

    it('caps an operator note at 500 characters rather than storing it in full', async () => {
      const docs: DocMap = {
        [`companies/${COMPANY_ID}`]: { name: COMPANY_NAME, deletion: PENDING },
        'companyDeletions/req-1': LEDGER,
      }
      const { tx } = wireTx(docs)
      const hugeNote = 'x'.repeat(5000)

      await cancelCompanyDeletionAsOperator(COMPANY_ID, hugeNote)

      const update = ledgerUpdate(tx, 'companyDeletions/req-1')
      const actions = (update![1] as { operatorActions: Array<{ note?: string }> }).operatorActions
      expect(actions[0].note).toHaveLength(500)
      expect(actions[0].note).toBe('x'.repeat(500))
    })

    it('a note under the cap is stored in full, untruncated', async () => {
      const docs: DocMap = {
        [`companies/${COMPANY_ID}`]: { name: COMPANY_NAME, deletion: PENDING },
        'companyDeletions/req-1': LEDGER,
      }
      const { tx } = wireTx(docs)
      const shortNote = 'ticket #123'

      await cancelCompanyDeletionAsOperator(COMPANY_ID, shortNote)

      const update = ledgerUpdate(tx, 'companyDeletions/req-1')
      const actions = (update![1] as { operatorActions: Array<{ note?: string }> }).operatorActions
      expect(actions[0].note).toBe(shortNote)
    })
  })
})
