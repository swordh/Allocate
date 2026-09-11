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
 * prevent. `memberCount` has exactly one home — no `_meta` counter — since
 * nothing outside this file enforces a plan limit against it today.
 *
 * This module is mirrored — duplicated, not imported — at
 * functions/src/companyStats.ts. See that file's docblock for why (the short
 * version: `import 'server-only'` two lines up throws outside a React Server
 * Component, and `adminDb` needs an env var Cloud Functions never has). Right
 * now only `memberCountDelta` has a mirror, because it's the only export a
 * Cloud Function calls. Keep the two copies in lockstep — updating one
 * without the other is exactly the kind of drift this module exists to
 * prevent, and the compiler cannot catch it across that boundary.
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

/**
 * Applies `delta` to `companies/{id}.stats.memberCount` via a merge-set —
 * same pattern as `bookingCreated`/`bookingCancelled`/the equipment mirror
 * half of `equipmentCountDelta`, and for the same reason: `memberCount` has
 * no `_meta` counter backing it (see the module docblock), so unlike
 * `equipmentCountDelta`'s counter half there is no "authoritative counter
 * that must fail loudly" contract to preserve here. It is a mirror only, and
 * a mirror must never be the reason a user operation fails.
 *
 * This matters concretely for `deleteAccount` (actions/account.ts): the
 * companies it iterates come from the deleted user's own `memberships`
 * documents, which can point at a company doc that no longer exists (a stale
 * pointer — the same class of orphan the equipment-stats PR was cleaning up,
 * just in the other direction). `.update()` throws on a missing document and
 * would fail the entire GDPR-erasure batch over a denormalized counter;
 * `.set(..., { merge: true })` creates the document with just this field
 * instead. `merge: true` on a nested `stats` map merges field-by-field, so
 * `FieldValue.increment` still behaves correctly and sibling stats fields are
 * left untouched, same as every other function in this module.
 *
 * Unlike every other function here, member count has no writer that runs
 * inside `adminDb.runTransaction` on the Next.js side — `removeMember`
 * (actions/team.ts) and `deleteAccount` (actions/account.ts) both apply their
 * writes through a chunked `WriteBatch` instead, so this accepts either.
 *
 * The parameter is typed structurally (a minimal `{ set }` shape), same
 * narrowing this module's `equipmentCountDelta` sibling would need if it ever
 * had to accept a `WriteBatch` too: `Transaction.set` and `WriteBatch.set` are
 * each generic AND overloaded (a `(data, options)` form and a bare `(data)`
 * form, each with its own type parameters), and TypeScript refuses to call
 * through a union of two independently-generic overload sets — the same
 * problem `update()` has, not one `set()` avoids. Narrowing to the one
 * `(data, options)` overload actually used here (options is always passed —
 * `{ merge: true }`) sidesteps that without an `as` cast.
 *
 * Mirrored at functions/src/companyStats.ts — see this module's docblock —
 * where `acceptInvitation` and `onUserCreate` call the Transaction-only
 * sibling from inside `db.runTransaction`. A missing company doc there would
 * be a genuine anomaly (not a stale-pointer scenario like deleteAccount's),
 * but a merge-set is still the safer behaviour: an invitation acceptance
 * should not fail because a stats mirror could not be written. Keep both in
 * lockstep.
 */
export function memberCountDelta(
  writer: {
    set(
      documentRef: FirebaseFirestore.DocumentReference,
      data: FirebaseFirestore.PartialWithFieldValue<FirebaseFirestore.DocumentData>,
      options: FirebaseFirestore.SetOptions,
    ): unknown
  },
  companyId: string,
  delta: 1 | -1,
): void {
  writer.set(
    companyRef(companyId),
    {
      stats: {
        memberCount: FieldValue.increment(delta),
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
