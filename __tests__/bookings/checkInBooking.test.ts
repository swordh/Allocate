/**
 * Tests for checkInBooking (issue #329): a manual check-in stamps `returnedAt`
 * and `returnSource: 'manual'` — the counterpart of the automation's `'auto'`
 * — and still only accepts a checked-out booking from an admin.
 *
 * Firebase Admin (adminDb) and getVerifiedSession are mocked; no network calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: { doc: vi.fn(), runTransaction: vi.fn() },
  adminAuth: {},
}))

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: vi.fn(),
}))

import { checkInBooking } from '@/actions/bookings'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { ADMIN_SESSION, CREW_SESSION, COMPANY_ID } from '../helpers/fixtures'

const BOOKING_ID = 'booking-1'
const BOOKING_PATH = `companies/${COMPANY_ID}/bookings/${BOOKING_ID}`

function wire(booking: Record<string, unknown> | null) {
  const tx = {
    get: vi.fn().mockResolvedValue({ exists: booking !== null, data: () => booking }),
    update: vi.fn(),
  }
  vi.mocked(adminDb.runTransaction).mockImplementation(
    (async (cb: (tx: unknown) => Promise<unknown>) => {
      await cb(tx)
    }) as never,
  )
  vi.mocked(adminDb.doc).mockImplementation((path: string) => ({ path }) as never)
  return tx
}

describe('checkInBooking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getVerifiedSession).mockResolvedValue(ADMIN_SESSION)
  })

  it('checks in a checked-out booking, stamping returnedAt and returnSource "manual"', async () => {
    const tx = wire({ status: 'checked_out' })

    const result = await checkInBooking(BOOKING_ID)

    expect(result).toEqual({})
    expect(tx.update).toHaveBeenCalledWith(expect.objectContaining({ path: BOOKING_PATH }), {
      status: 'returned',
      returnedAt: expect.anything(),
      returnSource: 'manual',
      updatedAt: expect.anything(),
    })
  })

  it('rejects a booking that is not checked out, without writing', async () => {
    const tx = wire({ status: 'confirmed' })

    const result = await checkInBooking(BOOKING_ID)

    expect(result).toEqual({ error: 'Only checked-out bookings can be checked in.' })
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('rejects non-admin callers before touching the transaction', async () => {
    vi.mocked(getVerifiedSession).mockResolvedValue(CREW_SESSION)

    expect(await checkInBooking(BOOKING_ID)).toEqual({ error: 'Unauthorized' })
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
  })
})
