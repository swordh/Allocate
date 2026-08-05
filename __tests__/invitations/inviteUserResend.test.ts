/**
 * inviteUser — resend branch (WP6).
 *
 * The single most likely bug in this phase: resending an existing pending
 * invite must extend `expiresAt` on both the private doc and the mirror.
 * Missing this means every resend of an 8-day-old invitation ships an
 * already-dead link.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {
    doc: vi.fn(),
    collection: vi.fn(),
    batch: vi.fn(),
  },
  adminAuth: {},
}))

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { inviteUser } from '@/actions/team'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { wireDb, type DocMap, type QueryResolver } from '../helpers/firestore'

const COMPANY_ID = 'company-A'
const EXISTING_INVITE_ID = 'invite-1'
const TOKEN = 'existingtoken0123456789abcdef01'
const EMAIL = 'crew@example.com'

function stubSession() {
  vi.mocked(getVerifiedSession).mockResolvedValue({
    uid: 'admin-1',
    email: 'admin@example.com',
    activeCompanyId: COMPANY_ID,
    role: 'admin',
  })
}

function wire() {
  const docs: DocMap = {
    [`companies/${COMPANY_ID}/members/admin-1`]: { name: 'Admin One' },
    [`companies/${COMPANY_ID}`]: { name: 'Nordfilm AB' },
  }

  const query: QueryResolver = (ctx) => {
    if (ctx.path === `companies/${COMPANY_ID}/members`) return [] // not already a member
    if (ctx.path === `companies/${COMPANY_ID}/invitations`) {
      return [
        {
          id: EXISTING_INVITE_ID,
          path: `companies/${COMPANY_ID}/invitations/${EXISTING_INVITE_ID}`,
          data: {
            id: EXISTING_INVITE_ID,
            email: EMAIL,
            role: 'crew',
            status: 'pending',
            token: TOKEN,
            invitedAt: '2026-07-28T00:00:00.000Z', // > 7 days old
            expiresAt: '2026-08-04T00:00:00.000Z', // already expired
          },
        },
      ]
    }
    return []
  }

  const wired = wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })

  // wireDb's collection chain has no `add` — inviteUser enqueues the outgoing
  // mail via `adminDb.collection('mail').add(...)`. Wrap the collection spy so
  // every chain also exposes a working `add`.
  const innerCollection = wired.collection as unknown as (path: string) => Record<string, unknown>
  const collectionWithAdd = vi.fn((path: string) => {
    const chain = innerCollection(path)
    chain['add'] = vi.fn().mockResolvedValue({ id: 'mail-1' })
    return chain
  })
  ;(adminDb as unknown as Record<string, unknown>)['collection'] = collectionWithAdd

  return wired
}

function makeFormData(email: string): FormData {
  const fd = new FormData()
  fd.set('email', email)
  return fd
}

describe('inviteUser — resend branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T00:00:00.000Z'))
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.allocate.at'
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('extends expiresAt on both the private doc and the mirror', async () => {
    stubSession()
    const { batch } = wire()

    const result = await inviteUser(makeFormData(EMAIL))

    expect(result.error).toBeUndefined()

    // Private doc update — expiresAt pushed 7 days out from "now".
    expect(batch.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: `companies/${COMPANY_ID}/invitations/${EXISTING_INVITE_ID}` }),
      { expiresAt: '2026-08-12T00:00:00.000Z' },
    )
    // Mirror update — same new expiresAt.
    expect(batch.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: `invitations/${TOKEN}` }),
      { expiresAt: '2026-08-12T00:00:00.000Z' },
    )
    expect(batch.commit).toHaveBeenCalled()
  })
})
