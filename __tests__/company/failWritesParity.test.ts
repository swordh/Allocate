/**
 * Guards `lib/companyDeletionFailWrites.ts`'s `applyFailedTransitionNext`
 * against drifting from `functions/src/company/failDeletion.ts`'s
 * `applyFailedTransition` — the two are supposed to write byte-for-byte the
 * same thing (App Hosting cannot import `functions/src`, so the Next side
 * carries its own copy; see that file's own docblock for why).
 *
 * Both builders are called with IDENTICAL inputs across several cases and
 * their recorded `tx.update`/`tx.set` calls are compared after normalizing
 * away the two things that are legitimately allowed to differ instance-for-
 * instance without being a drift: the fake `Timestamp` objects (reduced to
 * their millis) and the auto-generated `mail/{id}` doc path (reduced to a
 * wildcard — the two sides mint their ids from separate fake `db`/`adminDb`
 * doubles here, so the ids themselves are never expected to match).
 */

import { describe, expect, it } from 'vitest'
import type { CompanyDeletionDocument } from '../../functions/src/types'
import type { CompanyDeletionRecord } from '@/types'

let mailAutoId = 0

// The functions-side `applyFailedTransition` takes its `Firestore` in as a
// parameter, so a plain fake works with no module mock at all.
function fakeFunctionsDb() {
  return {
    collection: (name: string) => {
      if (name !== 'mail') throw new Error(`fakeFunctionsDb: unexpected collection '${name}'`)
      return { doc: () => ({ path: `mail/fn-${mailAutoId++}` }) }
    },
  }
}

// The Next-side `applyFailedTransitionNext` reaches `adminDb` directly
// (matching `applyCancelWrites`'s own convention in
// lib/companyDeletionCancelWrites.ts) rather than taking it as a parameter,
// so it needs a module mock instead.
import { vi } from 'vitest'
vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {
    collection: (name: string) => {
      if (name !== 'mail') throw new Error(`adminDb mock: unexpected collection '${name}'`)
      return { doc: () => ({ path: `mail/next-${mailAutoId++}` }) }
    },
  },
}))

import { applyFailedTransition } from '../../functions/src/company/failDeletion'
import { applyFailedTransitionNext } from '@/lib/companyDeletionFailWrites'

function fakeTimestamp(ms: number) {
  return { toMillis: () => ms, toDate: () => new Date(ms) }
}

interface RecordingTx {
  update: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
}

function makeRecordingTx(): RecordingTx {
  return { update: vi.fn(), set: vi.fn() }
}

/** Reduces a fake-Timestamp to its millis, a `mail/{autoId}` path to a
 *  wildcard, and recurses through plain objects/arrays — everything else is
 *  compared as-is. This is the "same write, different instance" allowance;
 *  anything ELSE differing between the two sides' calls is a real drift. */
function normalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    return `<timestamp:${(value as { toMillis: () => number }).toMillis()}>`
  }
  if (Array.isArray(value)) return value.map(normalize)
  if ('path' in value && typeof (value as { path: unknown }).path === 'string') {
    const path = (value as { path: string }).path
    return path.startsWith('mail/') ? 'mail/<auto>' : path
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalize(v)
  return out
}

function normalizeCalls(calls: unknown[][]): unknown[] {
  return calls.map((call) => call.map(normalize))
}

const LEDGER_REF = { path: 'companyDeletions/req-1' }

interface Case {
  name: string
  ledger: Record<string, unknown>
  companySnap: { exists: boolean; data: () => Record<string, unknown> | undefined; ref: { path: string } } | null
  adminsSnap: { docs: { data: () => Record<string, unknown> }[] } | null
}

const BASE_LEDGER = {
  requestId: 'req-1',
  companyId: 'company-1',
  companyName: 'Nordfilm AB',
  mode: 'window',
  requestedAt: fakeTimestamp(1_759_000_000_000),
}

const COMPANY_MATCHING = {
  exists: true,
  data: () => ({ deletion: { requestId: 'req-1' } }),
  ref: { path: 'companies/company-1' },
}

const ONE_ADMIN = { docs: [{ data: () => ({ email: 'admin@nordfilm.se' }) }] }

const CASES: Case[] = [
  {
    name: 'admins present',
    ledger: BASE_LEDGER,
    companySnap: COMPANY_MATCHING,
    adminsSnap: ONE_ADMIN,
  },
  {
    name: 'no admins, window mode — falls back to requestedByEmail',
    ledger: { ...BASE_LEDGER, requestedByEmail: 'requester@nordfilm.se' },
    companySnap: COMPANY_MATCHING,
    adminsSnap: { docs: [] },
  },
  {
    name: 'no admins, immediate mode — no fallback, no mail',
    ledger: { ...BASE_LEDGER, mode: 'immediate', requestedByEmail: 'requester@nordfilm.se' },
    companySnap: COMPANY_MATCHING,
    adminsSnap: { docs: [] },
  },
  {
    name: 'already notified — no mail sent again',
    ledger: { ...BASE_LEDGER, failedNotifiedAt: fakeTimestamp(1_759_500_000_000) },
    companySnap: COMPANY_MATCHING,
    adminsSnap: ONE_ADMIN,
  },
  {
    name: 'company missing — no mirror write',
    ledger: BASE_LEDGER,
    companySnap: null,
    adminsSnap: ONE_ADMIN,
  },
  {
    name: 'requestId mismatch — no mirror write',
    ledger: BASE_LEDGER,
    companySnap: {
      exists: true,
      data: () => ({ deletion: { requestId: 'a-newer-request' } }),
      ref: { path: 'companies/company-1' },
    },
    adminsSnap: ONE_ADMIN,
  },
  {
    // Review fix: recipientRole/billingStopped must be computed identically
    // on both sides, not just the recipient list itself.
    name: 'stripe phase already complete — billingStopped true',
    ledger: { ...BASE_LEDGER, completedPhases: ['stripe', 'invitations'] },
    companySnap: COMPANY_MATCHING,
    adminsSnap: ONE_ADMIN,
  },
  {
    name: 'stripe phase never reached — billingStopped false, requester fallback tagged correctly',
    ledger: { ...BASE_LEDGER, completedPhases: [], requestedByEmail: 'requester@nordfilm.se' },
    companySnap: COMPANY_MATCHING,
    adminsSnap: { docs: [] },
  },
]

describe('applyFailedTransition / applyFailedTransitionNext parity', () => {
  for (const reason of ['attempts_exhausted', 'no_progress', 'operator'] as const) {
    for (const { name, ledger, companySnap, adminsSnap } of CASES) {
      it(`${reason} — ${name}`, () => {
        const now = fakeTimestamp(1_760_000_000_000)

        const tx1 = makeRecordingTx()
        applyFailedTransition(tx1 as unknown as FirebaseFirestore.Transaction, {
          db: fakeFunctionsDb() as unknown as FirebaseFirestore.Firestore,
          ledgerRef: LEDGER_REF as unknown as FirebaseFirestore.DocumentReference,
          ledger: ledger as unknown as CompanyDeletionDocument,
          companySnap: companySnap as unknown as FirebaseFirestore.DocumentSnapshot | null,
          adminsSnap: adminsSnap as unknown as FirebaseFirestore.QuerySnapshot | null,
          reason,
          now: now as unknown as import('firebase-admin/firestore').Timestamp,
        })

        const tx2 = makeRecordingTx()
        applyFailedTransitionNext(tx2 as unknown as FirebaseFirestore.Transaction, {
          ledgerRef: LEDGER_REF as unknown as FirebaseFirestore.DocumentReference,
          ledger: ledger as unknown as CompanyDeletionRecord,
          companySnap: companySnap as unknown as FirebaseFirestore.DocumentSnapshot | null,
          adminsSnap: adminsSnap as unknown as FirebaseFirestore.QuerySnapshot | null,
          reason,
          now: now as unknown as import('firebase-admin/firestore').Timestamp,
        })

        expect(normalizeCalls(tx1.update.mock.calls)).toEqual(normalizeCalls(tx2.update.mock.calls))
        expect(normalizeCalls(tx1.set.mock.calls)).toEqual(normalizeCalls(tx2.set.mock.calls))

        // Not just parity — pin the actual computed values too, so both
        // sides drifting the SAME way (both wrong) still fails.
        if (name.includes('billingStopped true')) {
          for (const call of tx1.set.mock.calls) {
            expect((call[1] as { data: { billingStopped: boolean } }).data.billingStopped).toBe(true)
          }
        }
        if (name.includes('billingStopped false')) {
          for (const call of tx1.set.mock.calls) {
            expect((call[1] as { data: { billingStopped: boolean } }).data.billingStopped).toBe(false)
          }
        }
        if (name.includes('requester fallback tagged correctly')) {
          for (const call of tx1.set.mock.calls) {
            expect((call[1] as { data: { recipientRole: string } }).data.recipientRole).toBe('requester')
          }
        }
        if (name === 'admins present') {
          for (const call of tx1.set.mock.calls) {
            expect((call[1] as { data: { recipientRole: string } }).data.recipientRole).toBe('admin')
          }
        }
      })
    }
  }
})
