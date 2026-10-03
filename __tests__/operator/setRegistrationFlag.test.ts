/**
 * `setRegistrationFlag` — the operator System tab's kill-switch action
 * (app/operator/(protected)/system/actions.ts).
 *
 * Written so each guard fails a test if removed: operator check, reason
 * length, the no-op short-circuit, since-timestamp set/cleared, and that the
 * audit-log row carries the operator's identity and the TRIMMED reason.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { wireDb, makeTransaction, type DocMap, type DocRefStub } from '../helpers/firestore'

const { mockGetOperatorSession, mockRevalidatePath } = vi.hoisted(() => ({
  mockGetOperatorSession: vi.fn(),
  mockRevalidatePath: vi.fn(),
}))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__serverTimestamp__' },
}))

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: { doc: vi.fn(), collection: vi.fn(), runTransaction: vi.fn() },
}))

vi.mock('next/cache', () => ({ revalidatePath: mockRevalidatePath }))

vi.mock('@/lib/operator-dal', () => ({
  getOperatorSession: mockGetOperatorSession,
  rethrowRedirect: (err: unknown) => {
    const digest = (err as { digest?: string })?.digest ?? ''
    const msg = err instanceof Error ? err.message : ''
    if (digest.startsWith('NEXT_REDIRECT') || msg.startsWith('REDIRECT:')) throw err
  },
}))

import { setRegistrationFlag } from '@/app/operator/(protected)/system/actions'
import { adminDb } from '@/lib/firebase-admin'

const FLAGS_PATH = 'system/registration'
const OPERATOR = { uid: 'operator-uid', email: 'jocke@allocate.at' }

function wireTx(docs: DocMap) {
  wireDb(adminDb as unknown as Record<string, unknown>, { docs })
  const tx = makeTransaction(docs)
  vi.mocked(adminDb.runTransaction).mockImplementation(
    (cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx),
  )
  return tx
}

/** The tx.set calls, split into the flag-document write and the log-row write. */
function writes(tx: ReturnType<typeof makeTransaction>) {
  const calls = tx.set.mock.calls as Array<[DocRefStub, Record<string, unknown>, unknown?]>
  return {
    flag: calls.find(([ref]) => ref.path === FLAGS_PATH),
    log: calls.find(([ref]) => ref.path.startsWith(`${FLAGS_PATH}/log/`)),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetOperatorSession.mockResolvedValue(OPERATOR)
})

describe('setRegistrationFlag — authorisation and validation', () => {
  it('refuses a caller who is not an operator, and writes nothing', async () => {
    mockGetOperatorSession.mockRejectedValue(new Error('not an operator'))
    const tx = wireTx({})

    const result = await setRegistrationFlag('companies', true, 'Billing migration')

    expect(result).toEqual({ error: 'Not authorized.' })
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
    expect(tx.set).not.toHaveBeenCalled()
  })

  it('lets a redirect from the operator check propagate', async () => {
    mockGetOperatorSession.mockRejectedValue(new Error('REDIRECT:/login'))
    wireTx({})

    await expect(setRegistrationFlag('companies', true, 'Billing migration')).rejects.toThrow('REDIRECT:/login')
  })

  it.each(['', '  ', 'ab', '  a  ', ' ab '])('rejects a reason under 3 characters after trimming: %j', async (reason) => {
    const tx = wireTx({})

    const result = await setRegistrationFlag('accounts', true, reason)

    expect(result.error).toBeDefined()
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
    expect(tx.set).not.toHaveBeenCalled()
  })

  it('accepts a reason of exactly 3 characters', async () => {
    wireTx({ [FLAGS_PATH]: null })
    await expect(setRegistrationFlag('accounts', true, 'abc')).resolves.toEqual({ ok: true })
  })

  it('rejects an unknown switch name', async () => {
    const tx = wireTx({})
    const result = await setRegistrationFlag('emails' as never, true, 'Because')
    expect(result.error).toBeDefined()
    expect(tx.set).not.toHaveBeenCalled()
  })

  it('rejects a non-boolean value', async () => {
    const tx = wireTx({})
    const result = await setRegistrationFlag('accounts', 'yes' as never, 'Because')
    expect(result.error).toBeDefined()
    expect(tx.set).not.toHaveBeenCalled()
  })
})

describe('setRegistrationFlag — blocking', () => {
  it('sets the flag and its since timestamp, and writes one audit-log row', async () => {
    const tx = wireTx({ [FLAGS_PATH]: null })

    const result = await setRegistrationFlag('companies', true, '  Billing migration  ')

    expect(result).toEqual({ ok: true })
    const { flag, log } = writes(tx)

    expect(flag).toBeDefined()
    expect(flag![1]).toMatchObject({
      companiesBlocked: true,
      companiesBlockedSince: '__serverTimestamp__',
      updatedAt: '__serverTimestamp__',
    })
    // The other switch is not touched.
    expect(flag![1]).not.toHaveProperty('accountsBlocked')
    expect(flag![2]).toEqual({ merge: true })

    expect(log).toBeDefined()
    expect(log![1]).toEqual({
      switch: 'companies',
      newValue: true,
      operatorUid: OPERATOR.uid,
      operatorEmail: OPERATOR.email,
      reason: 'Billing migration',
      at: '__serverTimestamp__',
    })
    expect(tx.set).toHaveBeenCalledTimes(2)
  })

  it('writes the accounts switch to its own fields', async () => {
    const tx = wireTx({ [FLAGS_PATH]: null })

    await setRegistrationFlag('accounts', true, 'Bot sign-ups')

    const { flag } = writes(tx)
    expect(flag![1]).toMatchObject({ accountsBlocked: true, accountsBlockedSince: '__serverTimestamp__' })
    expect(flag![1]).not.toHaveProperty('companiesBlocked')
  })

  it('caps the stored reason at 500 characters', async () => {
    const tx = wireTx({ [FLAGS_PATH]: null })

    await setRegistrationFlag('accounts', true, 'x'.repeat(900))

    expect((writes(tx).log![1].reason as string).length).toBe(500)
  })

  it('revalidates the operator page and both customer pages', async () => {
    wireTx({ [FLAGS_PATH]: null })

    await setRegistrationFlag('accounts', true, 'Bot sign-ups')

    const paths = mockRevalidatePath.mock.calls.map(([p]) => p)
    expect(paths).toEqual(expect.arrayContaining(['/operator/system', '/signup', '/no-company']))
  })
})

describe('setRegistrationFlag — reopening', () => {
  it('clears the flag and nulls the since timestamp', async () => {
    const tx = wireTx({ [FLAGS_PATH]: { companiesBlocked: true, companiesBlockedSince: { toDate: () => new Date() } } })

    const result = await setRegistrationFlag('companies', false, 'Migration finished')

    expect(result).toEqual({ ok: true })
    const { flag, log } = writes(tx)
    expect(flag![1]).toMatchObject({ companiesBlocked: false, companiesBlockedSince: null })
    expect(log![1]).toMatchObject({ switch: 'companies', newValue: false, reason: 'Migration finished' })
  })
})

describe('setRegistrationFlag — no-op', () => {
  it('writes nothing and logs nothing when the switch already has the requested value', async () => {
    const tx = wireTx({ [FLAGS_PATH]: { accountsBlocked: true } })

    const result = await setRegistrationFlag('accounts', true, 'Double click')

    expect(result).toEqual({ ok: true, unchanged: true })
    expect(tx.set).not.toHaveBeenCalled()
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  it('treats a missing document as open, so reopening it is a no-op', async () => {
    const tx = wireTx({ [FLAGS_PATH]: null })

    const result = await setRegistrationFlag('companies', false, 'Already open')

    expect(result).toEqual({ ok: true, unchanged: true })
    expect(tx.set).not.toHaveBeenCalled()
  })
})

describe('setRegistrationFlag — failure', () => {
  it('returns an error, not a throw, when the transaction fails', async () => {
    wireTx({})
    vi.mocked(adminDb.runTransaction).mockRejectedValue(new Error('aborted'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await setRegistrationFlag('accounts', true, 'Bot sign-ups')

    expect(result.error).toBeDefined()
    expect(result.ok).toBeUndefined()
    errorSpy.mockRestore()
  })
})
