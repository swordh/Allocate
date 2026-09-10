import 'server-only'

import { FieldValue, type Transaction } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase-admin'

/**
 * Derived per-company stats mirrored onto `companies/{companyId}` so the operator
 * customer list can filter and sort them server-side instead of querying each
 * company's subcollections.
 *
 * Every field here must stay recomputable from subcollection documents — see
 * tools/backfill_company_stats.js. A field that cannot be recomputed makes drift
 * both undetectable and unrepairable.
 *
 * Route every counter mutation through this module. The equipment counter has two
 * homes and updating one without the other is the drift this module exists to
 * prevent.
 *
 * Contention note: these writes put the company document in the write set of
 * transactions that previously only read it, so concurrent booking creates in one
 * company now abort each other. That is acceptable at human booking rates. Moving
 * these writes outside the transaction would NOT help — the conflict comes from
 * the company doc being in the transaction's read set. The real escape hatch is
 * best-effort writes after commit plus periodic `--verify` reconciliation.
 */

function companyRef(companyId: string) {
  return adminDb.doc(`companies/${companyId}`)
}

/**
 * Applies `delta` to both the authoritative counter at
 * `companies/{id}/_meta/equipmentCount` and the mirror on the company document.
 *
 * The two writes deliberately differ: the counter uses `update`, which throws when
 * the document is missing, preserving the existing "Run the backfill migration
 * first" contract. The mirror uses a merge-set, which cannot fail that way — a
 * derived statistic must never be the reason an equipment operation fails.
 */
export function equipmentCountDelta(tx: Transaction, companyId: string, delta: 1 | -1): void {
  tx.update(adminDb.doc(`companies/${companyId}/_meta/equipmentCount`), {
    count: FieldValue.increment(delta),
    updatedAt: FieldValue.serverTimestamp(),
  })

  tx.set(
    companyRef(companyId),
    {
      stats: {
        equipmentCount: FieldValue.increment(delta),
        updatedAt: FieldValue.serverTimestamp(),
      },
    },
    { merge: true },
  )
}

/**
 * `lastBookingAt` resolves to the same commit timestamp as the booking's own
 * `createdAt`, so the mirror equals the recomputed value exactly.
 */
export function bookingCreated(tx: Transaction, companyId: string): void {
  tx.set(
    companyRef(companyId),
    {
      stats: {
        bookingsCreated: FieldValue.increment(1),
        lastBookingAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
    },
    { merge: true },
  )
}

/**
 * Counts cancellation events only. Rejection is deliberately excluded: a rejected
 * booking keeps `status: 'pending'` and remains cancellable, so counting both
 * would double-count, and the resulting document would be indistinguishable from a
 * plain cancellation — making the field impossible to recompute.
 */
export function bookingCancelled(tx: Transaction, companyId: string): void {
  tx.set(
    companyRef(companyId),
    {
      stats: {
        bookingsCancelled: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      },
    },
    { merge: true },
  )
}

/** Initial value for a new company. Written by setupNewCompany's batch. */
export const INITIAL_COMPANY_STATS = {
  equipmentCount: 0,
  bookingsCreated: 0,
  bookingsCancelled: 0,
  lastBookingAt: null,
} as const
