/**
 * `app/operator/(protected)/feedback/actions.ts`'s `updateFeedbackStatus` —
 * issue #338 PR 2 (retention). Covers the `closedAt` state machine that
 * `functions/src/admin/purgeOldFeedback.ts`'s 24-month sweep depends on:
 * SET on an open-ish → closed transition, DELETE on closed → open-ish, and
 * left UNTOUCHED on closed → closed (`done` ↔ `wont_fix`). A ticket that
 * never had `closedAt` set correctly on close would silently never age out
 * of the purge job — see functions/src/admin/purgeOldFeedback.ts's own
 * docblock for why a missing field never matches a `<` range filter.
 *
 * Firebase Admin is mocked; no network calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { wireDb, makeBatch, type DocMap } from '../helpers/firestore'

const { mockGetOperatorSession } = vi.hoisted(() => ({
  mockGetOperatorSession: vi.fn(),
}))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__serverTimestamp__',
    delete: () => '__delete__',
  },
}))

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {
    doc: vi.fn(),
    collection: vi.fn(),
    collectionGroup: vi.fn(),
    batch: vi.fn(),
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

import { updateFeedbackStatus } from '@/app/operator/(protected)/feedback/actions'
import { adminDb } from '@/lib/firebase-admin'

const TICKET_ID = 'ticket-1'
const OPERATOR_EMAIL = 'jocke@allocate.at'

function wireTicket(status: string | undefined, batch: ReturnType<typeof makeBatch>) {
  const docs: DocMap = {
    [`operatorFeedback/${TICKET_ID}`]: status === undefined ? {} : { status },
  }
  const wired = wireDb(adminDb as unknown as Record<string, unknown>, { docs })
  vi.mocked(adminDb.batch).mockReturnValue(batch as unknown as ReturnType<typeof adminDb.batch>)
  return wired
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetOperatorSession.mockResolvedValue({ uid: 'op-uid', email: OPERATOR_EMAIL })
})

describe('updateFeedbackStatus — closedAt', () => {
  it('sets closedAt (serverTimestamp) on open → closed', async () => {
    const batch = makeBatch()
    wireTicket('open', batch)

    const result = await updateFeedbackStatus(TICKET_ID, 'done')

    expect(result.error).toBeUndefined()
    const update = batch.update.mock.calls[0]
    expect(update[1]).toMatchObject({ status: 'done', closedAt: '__serverTimestamp__' })
  })

  it('sets closedAt on in_progress → wont_fix', async () => {
    const batch = makeBatch()
    wireTicket('in_progress', batch)

    await updateFeedbackStatus(TICKET_ID, 'wont_fix')

    const update = batch.update.mock.calls[0]
    expect(update[1]).toMatchObject({ status: 'wont_fix', closedAt: '__serverTimestamp__' })
  })

  it('sets closedAt when the doc predates the status field entirely (from undefined)', async () => {
    const batch = makeBatch()
    wireTicket(undefined, batch)

    await updateFeedbackStatus(TICKET_ID, 'done')

    const update = batch.update.mock.calls[0]
    expect(update[1]).toMatchObject({ status: 'done', closedAt: '__serverTimestamp__' })
    // No `from` means no event line — see the existing `if (from)` guard.
    expect(batch.set).not.toHaveBeenCalled()
  })

  it('deletes closedAt on done → open (reopened)', async () => {
    const batch = makeBatch()
    wireTicket('done', batch)

    await updateFeedbackStatus(TICKET_ID, 'open')

    const update = batch.update.mock.calls[0]
    expect(update[1]).toMatchObject({ status: 'open', closedAt: '__delete__' })
  })

  it('deletes closedAt on wont_fix → in_progress (reopened)', async () => {
    const batch = makeBatch()
    wireTicket('wont_fix', batch)

    await updateFeedbackStatus(TICKET_ID, 'in_progress')

    const update = batch.update.mock.calls[0]
    expect(update[1]).toMatchObject({ status: 'in_progress', closedAt: '__delete__' })
  })

  it('leaves closedAt untouched on done → wont_fix (closed → closed)', async () => {
    const batch = makeBatch()
    wireTicket('done', batch)

    await updateFeedbackStatus(TICKET_ID, 'wont_fix')

    const update = batch.update.mock.calls[0]
    expect(update[1]).toEqual({ status: 'wont_fix' })
    expect('closedAt' in update[1]).toBe(false)
  })

  it('leaves closedAt untouched on wont_fix → done (closed → closed)', async () => {
    const batch = makeBatch()
    wireTicket('wont_fix', batch)

    await updateFeedbackStatus(TICKET_ID, 'done')

    const update = batch.update.mock.calls[0]
    expect(update[1]).toEqual({ status: 'done' })
  })

  it('leaves closedAt untouched on open → in_progress (neither closed)', async () => {
    const batch = makeBatch()
    wireTicket('open', batch)

    await updateFeedbackStatus(TICKET_ID, 'in_progress')

    const update = batch.update.mock.calls[0]
    expect(update[1]).toEqual({ status: 'in_progress' })
  })

  it('does nothing at all when the status is unchanged', async () => {
    const batch = makeBatch()
    wireTicket('done', batch)

    await updateFeedbackStatus(TICKET_ID, 'done')

    expect(batch.update).not.toHaveBeenCalled()
    expect(batch.commit).not.toHaveBeenCalled()
  })
})
