/**
 * getAccountDeletionPreview (actions/account.ts) — issue #252 step 6 PR 2.
 *
 * A thin, read-only wrapper around getDeletionOutcomes (lib/queries/
 * deletionOutcomes.ts, already covered by __tests__/queries/
 * deletionOutcomes.test.ts). These tests exercise the wrapper's own two
 * jobs, and nothing getDeletionOutcomes itself is responsible for:
 *
 *   1. Passing the per-company results through UNCHANGED and per-company —
 *      the designbrief's "en användare kan vara vanlig medlem i ett företag,
 *      ensam admin i ett andra och ensam medlem i ett tredje" case, so a
 *      caller in several companies at once gets a distinct outcome for each
 *      one rather than a single collapsed verdict.
 *   2. Turning a THROWN error into `{ status: 'error' }` — kept distinct
 *      from a per-company `outcome: 'unknown'` inside `companies`, which is
 *      what getDeletionOutcomes itself already returns for a single failed
 *      company read (see that function's own tests). `status: 'error'` here
 *      is the "we have nothing to show at all" case; a per-company
 *      `'unknown'` is "everything else is fine, just not this one."
 *
 * getDeletionOutcomes and getVerifiedSession are both mocked directly so
 * these tests don't need to stand up Firestore/session-cookie fixtures for
 * behaviour that belongs to those modules' own test suites.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetVerifiedSession, mockGetDeletionOutcomes } = vi.hoisted(() => ({
  mockGetVerifiedSession: vi.fn(),
  mockGetDeletionOutcomes: vi.fn(),
}))

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: mockGetVerifiedSession,
  verifyAuthenticatedSession: vi.fn(),
}))

vi.mock('@/lib/queries/deletionOutcomes', () => ({
  getDeletionOutcomes: mockGetDeletionOutcomes,
  confirmSoleMember: vi.fn(),
}))

import { getAccountDeletionPreview } from '@/actions/account'

describe('getAccountDeletionPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetVerifiedSession.mockResolvedValue({ uid: 'user-1', email: 'user@example.com' })
  })

  it('reports a distinct outcome per company for a user in several companies at once', async () => {
    // Designbrief fall 4: vanlig medlem + ensam admin (andra finns) + ensam
    // medlem, all for the same caller, in one call.
    mockGetDeletionOutcomes.mockResolvedValue([
      { companyId: 'c-member', companyName: 'Member Co', role: 'crew', memberCount: 5, otherAdminCount: 2, outcome: 'leave' },
      { companyId: 'c-blocked', companyName: 'Blocked Co', role: 'admin', memberCount: 4, otherAdminCount: 0, outcome: 'blocked' },
      { companyId: 'c-close', companyName: 'Solo Co', role: 'admin', memberCount: 1, otherAdminCount: 0, outcome: 'close' },
    ])

    const result = await getAccountDeletionPreview()

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('expected ready')
    expect(result.companies).toHaveLength(3)
    expect(result.companies.map((c) => c.outcome)).toEqual(['leave', 'blocked', 'close'])
    expect(result.companies.find((c) => c.companyId === 'c-blocked')?.companyName).toBe('Blocked Co')
    expect(result.companies.find((c) => c.companyId === 'c-close')?.companyName).toBe('Solo Co')
  })

  it('passes through a per-company "unknown" outcome without touching the others', async () => {
    mockGetDeletionOutcomes.mockResolvedValue([
      { companyId: 'c-ok', companyName: 'Fine Co', role: 'crew', memberCount: 3, otherAdminCount: 1, outcome: 'leave' },
      { companyId: 'c-bad', companyName: '', role: 'admin', memberCount: 0, otherAdminCount: 0, outcome: 'unknown' },
    ])

    const result = await getAccountDeletionPreview()

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('expected ready')
    expect(result.companies.find((c) => c.companyId === 'c-ok')?.outcome).toBe('leave')
    expect(result.companies.find((c) => c.companyId === 'c-bad')?.outcome).toBe('unknown')
  })

  it('returns an empty, ready list for a user who belongs to no company', async () => {
    mockGetDeletionOutcomes.mockResolvedValue([])

    const result = await getAccountDeletionPreview()

    expect(result).toEqual({ status: 'ready', companies: [] })
  })

  it('returns status "error" — never a fabricated per-company list — when the read itself throws', async () => {
    mockGetDeletionOutcomes.mockRejectedValue(new Error('firestore unavailable'))
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await getAccountDeletionPreview()

    expect(result).toEqual({ status: 'error' })
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[actions/account]',
      expect.objectContaining({ action: 'account_deletion_preview_failed' }),
    )

    consoleErrorSpy.mockRestore()
  })

  it('is read-only: never calls anything beyond getVerifiedSession and getDeletionOutcomes', async () => {
    mockGetDeletionOutcomes.mockResolvedValue([])

    await getAccountDeletionPreview()

    expect(mockGetVerifiedSession).toHaveBeenCalledTimes(1)
    expect(mockGetDeletionOutcomes).toHaveBeenCalledWith('user-1')
    expect(mockGetDeletionOutcomes).toHaveBeenCalledTimes(1)
  })
})
