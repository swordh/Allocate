/**
 * `lib/registrationFlags.ts` — reads the operator kill switches from
 * `system/registration`. The contract that matters: a MISSING document means
 * both switches are open (fail-open), so shipping the feature blocks nobody
 * until an operator flips something.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }))

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: { doc: vi.fn(() => ({ get: mockGet })) },
}))

import { getRegistrationFlags, getRegistrationFlagsOrOpen } from '@/lib/registrationFlags'
import { adminDb } from '@/lib/firebase-admin'

const stamp = (iso: string) => ({ toDate: () => new Date(iso) })

beforeEach(() => {
  mockGet.mockReset()
})

describe('getRegistrationFlags', () => {
  it('reads system/registration', async () => {
    mockGet.mockResolvedValue({ exists: false, data: () => undefined })
    await getRegistrationFlags()
    expect(adminDb.doc).toHaveBeenCalledWith('system/registration')
  })

  it('reports both switches open when the document is missing', async () => {
    mockGet.mockResolvedValue({ exists: false, data: () => undefined })

    await expect(getRegistrationFlags()).resolves.toEqual({
      accountsBlocked: false,
      accountsBlockedSince: null,
      companiesBlocked: false,
      companiesBlockedSince: null,
    })
  })

  it('reports both switches open when the document exists but has no fields', async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({}) })

    const flags = await getRegistrationFlags()
    expect(flags.accountsBlocked).toBe(false)
    expect(flags.companiesBlocked).toBe(false)
  })

  it('reads each switch independently and serialises the since timestamp to ISO', async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({
        accountsBlocked: false,
        accountsBlockedSince: null,
        companiesBlocked: true,
        companiesBlockedSince: stamp('2026-10-03T08:12:00.000Z'),
      }),
    })

    await expect(getRegistrationFlags()).resolves.toEqual({
      accountsBlocked: false,
      accountsBlockedSince: null,
      companiesBlocked: true,
      companiesBlockedSince: '2026-10-03T08:12:00.000Z',
    })
  })

  it('only treats a literal true as blocked', async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ accountsBlocked: 'true', companiesBlocked: 1 }),
    })

    const flags = await getRegistrationFlags()
    expect(flags.accountsBlocked).toBe(false)
    expect(flags.companiesBlocked).toBe(false)
  })

  it('does not swallow a read error', async () => {
    mockGet.mockRejectedValue(new Error('unavailable'))
    await expect(getRegistrationFlags()).rejects.toThrow('unavailable')
  })
})

describe('getRegistrationFlagsOrOpen (page layer)', () => {
  it('treats a read error as open and logs it', async () => {
    mockGet.mockRejectedValue(new Error('unavailable'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(getRegistrationFlagsOrOpen()).resolves.toEqual({
      accountsBlocked: false,
      accountsBlockedSince: null,
      companiesBlocked: false,
      companiesBlockedSince: null,
    })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  it('passes real flags through when the read succeeds', async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({ companiesBlocked: true }) })

    const flags = await getRegistrationFlagsOrOpen()
    expect(flags.companiesBlocked).toBe(true)
  })
})
