/**
 * Tests for cancelBooking, focused on the company stats mirror.
 *
 * bookingsCancelled counts cancellation events, and the status guards are what
 * make it correct: without them a repeated cancel would inflate the counter, and
 * the value would stop matching a recount of status == 'cancelled' documents.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {
    doc: vi.fn(),
    runTransaction: vi.fn(),
  },
  adminAuth: {},
}))

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: vi.fn(),
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { cancelBooking } from '@/actions/bookings'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'

import { ADMIN_SESSION, COMPANY_ID } from '../helpers/fixtures'

const BOOKING_ID = 'booking-1'
const BOOKING_PATH = `companies/${COMPANY_ID}/bookings/${BOOKING_ID}`

function wireTransaction(bookingData: Record<string, unknown> | null) {
  const tx = {
    get: vi.fn().mockImplementation((ref: { path: string }) =>
      Promise.resolve({
        exists: bookingData !== null,
        data: () => bookingData,
        id: ref.path.split('/').pop(),
      }),
    ),
    set: vi.fn(),
    update: vi.fn(),
  }

  vi.mocked(adminDb.runTransaction).mockImplementation(
    (async (cb: (tx: unknown) => Promise<unknown>) => {
      await cb(tx)
    }) as never,
  )

  vi.mocked(adminDb.doc).mockImplementation((path: string) => ({
    path,
    id: path.split('/').pop(),
  } as never))

  return { tx }
}

function companyStatsCalls(tx: { set: ReturnType<typeof vi.fn> }) {
  return tx.set.mock.calls.filter(
    (call: unknown[]) => (call[0] as { path?: string })?.path === `companies/${COMPANY_ID}`,
  )
}

describe('cancelBooking — company stats mirror', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getVerifiedSession).mockResolvedValue(ADMIN_SESSION)
  })

  it('increments bookingsCancelled in the same transaction as the status write', async () => {
    const { tx } = wireTransaction({ userId: ADMIN_SESSION.uid, status: 'confirmed' })

    const result = await cancelBooking(BOOKING_ID)

    expect(result).toEqual({})
    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: BOOKING_PATH }),
      expect.objectContaining({ status: 'cancelled' }),
    )

    const statsCalls = companyStatsCalls(tx)
    expect(statsCalls).toHaveLength(1)

    const [, payload, options] = statsCalls[0]
    const stats = (payload as { stats: Record<string, unknown> }).stats
    expect(stats.bookingsCancelled).toBeDefined() // FieldValue.increment(1)
    expect(options).toEqual({ merge: true })
  })

  it('does not touch the mirror when the booking is already cancelled', async () => {
    const { tx } = wireTransaction({ userId: ADMIN_SESSION.uid, status: 'cancelled' })

    const result = await cancelBooking(BOOKING_ID)

    expect(result).toHaveProperty('error')
    expect(companyStatsCalls(tx)).toHaveLength(0)
  })
})
