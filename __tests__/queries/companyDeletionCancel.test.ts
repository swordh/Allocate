/**
 * `lookupCancelToken` (lib/queries/companyDeletionCancel.ts) — direct unit
 * tests for the two fixes this ledger threading picked up:
 *
 *   - issue #361: the `valid` result now carries the company's OWN
 *     `preferences.timezone` (not the visitor's browser zone), so
 *     `CancelDeletionView` can render `scheduledFor` in the same zone the
 *     mail that linked here already used.
 *   - issue #334: `requestedByName` is now ALREADY resolved to the display
 *     string an unauthenticated link holder should see — an
 *     operator-initiated request must never leak the operator's own email
 *     here, same as everywhere else a requester is shown to a customer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { wireDb, type DocMap } from '../helpers/firestore'

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {
    doc: vi.fn(),
    collection: vi.fn(),
    collectionGroup: vi.fn(),
  },
}))

import { lookupCancelToken } from '@/lib/queries/companyDeletionCancel'
import { adminDb } from '@/lib/firebase-admin'

const TOKEN = 'tok-abc123'
const REQUEST_ID = 'req-1'
const COMPANY_ID = 'company-A'
const COMPANY_NAME = 'Nordfilm AB'

const FUTURE = { toDate: () => new Date('2026-09-28T00:00:00.000Z') }

function wire(opts: {
  ledger?: Record<string, unknown> | null
  token?: Record<string, unknown> | null
  company?: Record<string, unknown> | null
}) {
  const docs: DocMap = {}
  if (opts.token !== undefined) docs[`companyDeletionCancelTokens/${TOKEN}`] = opts.token
  if (opts.ledger !== undefined) docs[`companyDeletions/${REQUEST_ID}`] = opts.ledger
  if (opts.company !== undefined) docs[`companies/${COMPANY_ID}`] = opts.company
  wireDb(adminDb as unknown as Record<string, unknown>, { docs })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('lookupCancelToken — issue #361 timezone', () => {
  const BASE_LEDGER = {
    requestId: REQUEST_ID,
    companyId: COMPANY_ID,
    companyName: COMPANY_NAME,
    state: 'requested',
    scheduledFor: FUTURE,
    requestedByName: 'Anna Admin',
  }
  const BASE_TOKEN = { requestId: REQUEST_ID, companyId: COMPANY_ID, expiresAt: FUTURE }

  it('returns the company\'s own preferences.timezone for a valid token', async () => {
    wire({
      token: BASE_TOKEN,
      ledger: BASE_LEDGER,
      company: { name: COMPANY_NAME, preferences: { timezone: 'Europe/Stockholm' } },
    })
    const result = await lookupCancelToken(TOKEN)
    expect(result.state).toBe('valid')
    expect(result.timezone).toBe('Europe/Stockholm')
  })

  it('falls back to UTC when the company has no timezone preference set', async () => {
    wire({ token: BASE_TOKEN, ledger: BASE_LEDGER, company: { name: COMPANY_NAME } })
    const result = await lookupCancelToken(TOKEN)
    expect(result.state).toBe('valid')
    expect(result.timezone).toBe('UTC')
  })

  it('does not surface a timezone for a non-valid outcome (used token)', async () => {
    wire({ token: { ...BASE_TOKEN, usedAt: FUTURE }, ledger: BASE_LEDGER, company: { name: COMPANY_NAME } })
    const result = await lookupCancelToken(TOKEN)
    expect(result.state).toBe('used')
    expect(result.timezone).toBeUndefined()
  })
})

describe('lookupCancelToken — issue #334 requester display', () => {
  const BASE_TOKEN = { requestId: REQUEST_ID, companyId: COMPANY_ID, expiresAt: FUTURE }

  it('renders the requester name directly for an admin-sourced request', async () => {
    wire({
      token: BASE_TOKEN,
      ledger: {
        requestId: REQUEST_ID,
        companyId: COMPANY_ID,
        companyName: COMPANY_NAME,
        state: 'requested',
        scheduledFor: FUTURE,
        requestedByName: 'Anna Admin',
      },
      company: { name: COMPANY_NAME },
    })
    const result = await lookupCancelToken(TOKEN)
    expect(result.requestedByName).toBe('Anna Admin')
  })

  it('NEVER leaks the operator email for an operator-sourced request — renders the fixed support string instead', async () => {
    wire({
      token: BASE_TOKEN,
      ledger: {
        requestId: REQUEST_ID,
        companyId: COMPANY_ID,
        companyName: COMPANY_NAME,
        state: 'requested',
        scheduledFor: FUTURE,
        requestedByName: 'jocke@allocate.at',
        requestSource: 'operator',
      },
      company: { name: COMPANY_NAME },
    })
    const result = await lookupCancelToken(TOKEN)
    expect(result.requestedByName).toBe('Allocate support (support@allocate.at)')
    expect(result.requestedByName).not.toContain('jocke@allocate.at')
  })

  it('renders the requester name for a legacy row with no requestSource at all', async () => {
    wire({
      token: BASE_TOKEN,
      ledger: {
        requestId: REQUEST_ID,
        companyId: COMPANY_ID,
        companyName: COMPANY_NAME,
        state: 'requested',
        scheduledFor: FUTURE,
        requestedByName: 'Anna Admin',
      },
      company: { name: COMPANY_NAME },
    })
    const result = await lookupCancelToken(TOKEN)
    expect(result.requestedByName).toBe('Anna Admin')
  })
})
