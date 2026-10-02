/**
 * Tests for checkOutBooking, focused on issue #327: an early checkout (the
 * admin hits "check out now" before the booking's own start) must re-run
 * conflict detection against the shrunk window — in the company's own
 * timezone, not the server's — so a same-day booking that starts later today
 * on the same equipment is still caught.
 *
 * Firebase Admin (adminDb) and getVerifiedSession are mocked; no network
 * calls are made. System time is faked per test via vi.useFakeTimers() so
 * "now" in the company's timezone is deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('@/lib/firebase-admin', () => {
  const mockDb = {
    doc: vi.fn(),
    collection: vi.fn(),
    runTransaction: vi.fn(),
  }
  return { adminDb: mockDb, adminAuth: {} }
})

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: vi.fn(),
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { checkOutBooking } from '@/actions/bookings'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'

import { ADMIN_SESSION, CREW_SESSION, COMPANY_ID } from '../helpers/fixtures'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BOOKING_ID = 'booking-1'
const BOOKING_PATH = `companies/${COMPANY_ID}/bookings/${BOOKING_ID}`
const COMPANY_PATH = `companies/${COMPANY_ID}`
const EQUIPMENT_ID = 'equip-1'
const EQUIPMENT_PATH = `companies/${COMPANY_ID}/equipment/${EQUIPMENT_ID}`

const STOCKHOLM_COMPANY = { preferences: { timezone: 'Europe/Stockholm' } }

/** Quantity-tracked equipment with a single unit of stock — easiest to conflict. */
const SCARCE_EQUIPMENT = {
  name: 'Dolly',
  active: true,
  trackingType: 'quantity' as const,
  totalQuantity: 1,
  requiresApproval: false,
  approverId: null,
}

const BOOKING_ITEMS = [{ equipmentId: EQUIPMENT_ID, quantity: 1 }]

/**
 * Wire adminDb.runTransaction the same way createBooking.test.ts does:
 * tx.get() resolves doc reads from `snapshotMap` by path, and query reads
 * (no `.path` on the ref) from `queryDocs`.
 */
function wireTransaction(
  snapshotMap: Record<string, Record<string, unknown> | null>,
  queryDocs: Array<{ id: string; data: Record<string, unknown> }> = [],
) {
  const tx = {
    get: vi.fn().mockImplementation((refOrQuery: unknown) => {
      const ref = refOrQuery as { path?: string }
      if (ref.path) {
        const data = snapshotMap[ref.path] ?? null
        return Promise.resolve({
          exists: data !== null,
          data: () => data,
          id: ref.path.split('/').pop(),
        })
      }
      return Promise.resolve({
        docs: queryDocs.map((d) => ({ id: d.id, data: () => d.data })),
      })
    }),
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

  vi.mocked(adminDb.collection).mockImplementation((path: string) => ({
    path,
    where: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        get: vi.fn().mockResolvedValue({
          docs: queryDocs.map((d) => ({ id: d.id, data: () => d.data })),
        }),
      }),
    }),
  } as never))

  return { tx }
}

describe('checkOutBooking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getVerifiedSession).mockResolvedValue(ADMIN_SESSION)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Auth guards ────────────────────────────────────────────────────────────

  it('rejects non-admin callers before touching the transaction', async () => {
    vi.mocked(getVerifiedSession).mockResolvedValue(CREW_SESSION)

    const result = await checkOutBooking(BOOKING_ID)

    expect(result).toEqual({ error: 'Unauthorized' })
    expect(adminDb.runTransaction).not.toHaveBeenCalled()
  })

  it('rejects when the company document is missing', async () => {
    wireTransaction({
      [COMPANY_PATH]: null,
      [BOOKING_PATH]: {
        status: 'confirmed',
        startDate: '2026-06-15',
        endDate: '2026-06-15',
        items: BOOKING_ITEMS,
      },
    })

    const result = await checkOutBooking(BOOKING_ID)

    expect(result).toEqual({ error: 'Company not found.' })
  })

  it('rejects a booking that is not confirmed', async () => {
    wireTransaction({
      [COMPANY_PATH]: STOCKHOLM_COMPANY,
      [BOOKING_PATH]: {
        status: 'checked_out',
        startDate: '2026-06-15',
        endDate: '2026-06-15',
        items: BOOKING_ITEMS,
      },
    })

    const result = await checkOutBooking(BOOKING_ID)

    expect(result).toEqual({ error: 'Only confirmed bookings can be checked out.' })
  })

  // ── Same-day conflicts (issue #327) ─────────────────────────────────────────

  describe('same-day early checkout', () => {
    beforeEach(() => {
      // 2026-06-15 08:00 UTC = 2026-06-15 10:00 Europe/Stockholm (CEST, UTC+2).
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-06-15T08:00:00.000Z'))
    })

    it('blocks checkout when another booking already holds the equipment later today', async () => {
      const { tx } = wireTransaction(
        {
          [COMPANY_PATH]: STOCKHOLM_COMPANY,
          [BOOKING_PATH]: {
            status: 'confirmed',
            startDate: '2026-06-15',
            endDate: '2026-06-15',
            startTime: '19:00',
            endTime: '21:00',
            items: BOOKING_ITEMS,
          },
          [EQUIPMENT_PATH]: SCARCE_EQUIPMENT,
        },
        [
          {
            id: 'booking-conflict',
            data: {
              startDate: '2026-06-15',
              endDate: '2026-06-15',
              startTime: '15:00',
              endTime: '18:00',
              status: 'confirmed',
              approvalStatus: 'none',
              equipmentIds: [EQUIPMENT_ID],
              items: BOOKING_ITEMS,
            },
          },
        ],
      )

      const result = await checkOutBooking(BOOKING_ID)

      expect(result).toEqual({ error: expect.stringContaining('already booked') })
      expect(tx.update).not.toHaveBeenCalled()
    })

    it('checks out and moves start to now when there is no conflict', async () => {
      const { tx } = wireTransaction({
        [COMPANY_PATH]: STOCKHOLM_COMPANY,
        [BOOKING_PATH]: {
          status: 'confirmed',
          startDate: '2026-06-15',
          endDate: '2026-06-15',
          startTime: '19:00',
          endTime: '21:00',
          items: BOOKING_ITEMS,
        },
        [EQUIPMENT_PATH]: SCARCE_EQUIPMENT,
      })

      const result = await checkOutBooking(BOOKING_ID)

      expect(result).toEqual({})
      expect(tx.update).toHaveBeenCalledWith(
        expect.objectContaining({ path: BOOKING_PATH }),
        expect.objectContaining({
          status: 'checked_out',
          startDate: '2026-06-15',
          startTime: '10:00', // Stockholm local time, not UTC 08:00
          endTime: '21:00', // kept, not widened — booking already had an explicit end
        }),
      )
    })

    it('widens an all-day booking to an explicit 23:59 end on early checkout', async () => {
      const { tx } = wireTransaction({
        [COMPANY_PATH]: STOCKHOLM_COMPANY,
        [BOOKING_PATH]: {
          status: 'confirmed',
          startDate: '2026-06-16', // starts tomorrow
          endDate: '2026-06-16',
          startTime: null,
          endTime: null,
          items: BOOKING_ITEMS,
        },
        [EQUIPMENT_PATH]: SCARCE_EQUIPMENT,
      })

      const result = await checkOutBooking(BOOKING_ID)

      expect(result).toEqual({})
      expect(tx.update).toHaveBeenCalledWith(
        expect.objectContaining({ path: BOOKING_PATH }),
        expect.objectContaining({
          status: 'checked_out',
          startDate: '2026-06-15',
          startTime: '10:00',
          endTime: '23:59',
        }),
      )
    })

    it('does not treat a booking that already ended earlier today as a conflict', async () => {
      const { tx } = wireTransaction(
        {
          [COMPANY_PATH]: STOCKHOLM_COMPANY,
          [BOOKING_PATH]: {
            status: 'confirmed',
            startDate: '2026-06-15',
            endDate: '2026-06-15',
            startTime: '19:00',
            endTime: '21:00',
            items: BOOKING_ITEMS,
          },
          [EQUIPMENT_PATH]: SCARCE_EQUIPMENT,
        },
        [
          {
            id: 'booking-earlier-today',
            data: {
              startDate: '2026-06-15',
              endDate: '2026-06-15',
              startTime: '06:00',
              endTime: '08:00',
              status: 'confirmed',
              approvalStatus: 'none',
              equipmentIds: [EQUIPMENT_ID],
              items: BOOKING_ITEMS,
            },
          },
        ],
      )

      const result = await checkOutBooking(BOOKING_ID)

      expect(result).toEqual({})
      expect(tx.update).toHaveBeenCalledWith(
        expect.objectContaining({ path: BOOKING_PATH }),
        expect.objectContaining({ status: 'checked_out', startDate: '2026-06-15' }),
      )
    })

    it('uses the Stockholm civil date, not the UTC one, near the day boundary', async () => {
      // 2026-06-14 23:30 UTC = 2026-06-15 01:30 Europe/Stockholm.
      // Fake timers freeze the clock for the whole test, so this proves the
      // timezone conversion itself — not that today/nowTime come from a
      // single captured Date (see the single-clock-read comment in
      // checkOutBooking; that guarantee isn't observable under a frozen clock).
      vi.setSystemTime(new Date('2026-06-14T23:30:00.000Z'))

      const { tx } = wireTransaction({
        [COMPANY_PATH]: STOCKHOLM_COMPANY,
        [BOOKING_PATH]: {
          status: 'confirmed',
          startDate: '2026-06-15',
          endDate: '2026-06-15',
          startTime: '02:00',
          endTime: '04:00',
          items: BOOKING_ITEMS,
        },
        [EQUIPMENT_PATH]: SCARCE_EQUIPMENT,
      })

      const result = await checkOutBooking(BOOKING_ID)

      expect(result).toEqual({})
      expect(tx.update).toHaveBeenCalledWith(
        expect.objectContaining({ path: BOOKING_PATH }),
        expect.objectContaining({
          startDate: '2026-06-15', // Stockholm's date, not '2026-06-14' (UTC's)
          startTime: '01:30',
        }),
      )
    })
  })

  // ── Checkout after the booking's own start ──────────────────────────────────

  it('checks out status-only, with no conflict query, once the booking has already started', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-15T08:00:00.000Z')) // 10:00 Stockholm

    const { tx } = wireTransaction({
      [COMPANY_PATH]: STOCKHOLM_COMPANY,
      [BOOKING_PATH]: {
        status: 'confirmed',
        startDate: '2026-06-15',
        endDate: '2026-06-15',
        startTime: '08:00', // already started (before 10:00 now)
        endTime: '21:00',
        items: BOOKING_ITEMS,
      },
      // No equipment doc wired — if the code tried to conflict-check it would
      // throw on the missing tx.get() snapshot, failing this test.
    })

    const result = await checkOutBooking(BOOKING_ID)

    expect(result).toEqual({})
    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: BOOKING_PATH }),
      {
        status: 'checked_out',
        checkedOutAt: expect.anything(),
        checkOutSource: 'manual',
        updatedAt: expect.anything(),
      },
    )
  })

  it('stamps checkedOutAt and checkOutSource "manual" on an early checkout too (#329)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-15T08:00:00.000Z')) // 10:00 Stockholm

    const { tx } = wireTransaction(
      {
        [COMPANY_PATH]: STOCKHOLM_COMPANY,
        [BOOKING_PATH]: {
          status: 'confirmed',
          startDate: '2026-06-15',
          endDate: '2026-06-15',
          startTime: '14:00', // not started yet — early checkout
          endTime: '21:00',
          items: BOOKING_ITEMS,
        },
        [EQUIPMENT_PATH]: SCARCE_EQUIPMENT,
      },
      [],
    )

    const result = await checkOutBooking(BOOKING_ID)

    expect(result).toEqual({})
    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: BOOKING_PATH }),
      expect.objectContaining({ status: 'checked_out', checkOutSource: 'manual', checkedOutAt: expect.anything() }),
    )
  })
})
