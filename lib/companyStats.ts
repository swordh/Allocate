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
 * prevent. `memberCount` now has two homes as well: `companies/{id}/_meta/memberCounts`
 * (which also carries `admins`, for the sole-admin guards in actions/team.ts and
 * actions/account.ts) and the `companies/{id}.stats.memberCount` mirror. See
 * `memberCountsDelta` and `readMemberCounts` below.
 *
 * This module is mirrored — duplicated, not imported — at
 * functions/src/companyStats.ts. See that file's docblock for why (the short
 * version: `import 'server-only'` two lines up throws outside a React Server
 * Component, and `adminDb` needs an env var Cloud Functions never has). Right
 * now only `memberCountsDelta` has a mirror, because it's the only export a
 * Cloud Function calls — `readMemberCounts` is deliberately NOT mirrored, see
 * that function's own docblock. Keep the two copies in lockstep — updating one
 * without the other is exactly the kind of drift this module exists to
 * prevent, and the compiler cannot catch it across that boundary.
 *
 * Footgun to remember: `updateMemberRole` (actions/team.ts) changes a member's
 * `role` field but never their membership itself, so it must NEVER call
 * `memberCountsDelta` with a non-zero `members` delta — only `admins` moves
 * on a role change. Conflating the two would double-count `members` against
 * every promotion/demotion.
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

function memberCountsRef(companyId: string) {
  return adminDb.doc(`companies/${companyId}/_meta/memberCounts`)
}

/**
 * Per-call delta for `memberCountsDelta`. Each field is `-1 | 0 | 1` — never a
 * larger magnitude — because every writer applies exactly one membership
 * change (one join, one removal, one role flip) per call. `0` means "this
 * field is untouched by this call", not "set it to zero" — see
 * `memberCountsDelta`'s own docblock for why a `0` field is omitted from the
 * write entirely rather than sent as `FieldValue.increment(0)`.
 */
export type MemberCountsDelta = { members: -1 | 0 | 1; admins: -1 | 0 | 1 }

/**
 * Reads `companies/{id}/_meta/memberCounts` — the authoritative, O(1) counter
 * the sole-admin guards in `removeMember`, `updateMemberRole`, and
 * `deleteAccount` read before deciding whether a removal/demotion/deletion is
 * safe. Despite the self-healing behaviour described below, this function
 * itself is read-only — it issues zero `tx.set`/`tx.update` calls. See
 * `applyHeal` for where the (optional) write actually happens.
 *
 * Self-healing: a company created before this counter existed (or one whose
 * seeding write in actions/auth.ts never ran) has no `_meta/memberCounts`
 * doc. Rather than fail the guard or fail closed, this falls back to a live
 * aggregate count in the SAME transaction. This is safe specifically because
 * `Transaction.get(AggregateQuery)` takes Firestore's normal pessimistic
 * transaction lock on every document the aggregate matches — verified
 * against real Firestore (SDK 7.11.6, tested against allocate-alpha) — so a
 * concurrent write to any matched member document still aborts and retries
 * this transaction, exactly as it would for a non-aggregate `tx.get()`. A
 * fallback that read the aggregate OUTSIDE the transaction and then decided
 * based on it would reintroduce the exact TOCTOU race this counter exists to
 * close; doing both reads inside the same transaction as the eventual guard
 * decision is what makes the heal itself race-free.
 *
 * `applyHeal()` is a separate, deferred closure rather than a `tx.set()`
 * issued here, because Firestore requires every read in a transaction to
 * happen before any write — if this function wrote the healed value
 * immediately, it would have to be the LAST read in the callback, and that
 * contract has no way to be enforced by the type system or a mock. A caller
 * who still needs to read something else after `readMemberCounts` (the
 * planned `deleteAccount` commit-loop reads the target's own member doc,
 * for instance) would pass typechecking and mocked tests, then fail only
 * against real Firestore with an opaque read-after-write error — exactly the
 * mistake this module's own planning notes made once already in pseudocode.
 * Deferring the write into a closure the caller invokes explicitly, once it
 * is done reading, removes the ordering trap entirely: call
 * `readMemberCounts` first, do as many `tx.get()` calls as needed, then call
 * `applyHeal()` before any `tx.set`/`tx.update`/`tx.delete`. It is a no-op
 * when `healed` is `false`, so callers can call it unconditionally.
 *
 * Forgetting to call `applyHeal()` is benign by design: the heal simply
 * doesn't persist this time, and the next read of this counter (by any
 * caller) heals it again from the same live aggregate. That is the point of
 * this shape — a caller mistake here degrades to "self-heals once more than
 * necessary," never to a thrown transaction error.
 *
 * `healed` (and the values `applyHeal` will persist) are surfaced so callers
 * can log them — that is the only signal that a company is running on the
 * fallback path rather than the counter, and it should show up in Cloud
 * Logging without needing to run `tools/backfill_company_stats.js --verify`
 * to notice.
 *
 * Not mirrored at functions/src/companyStats.ts: nothing under functions/src
 * reads this counter today (see that file's docblock) — Cloud Functions only
 * ever increment it via `memberCountsDelta`.
 */
export async function readMemberCounts(
  tx: Transaction,
  companyId: string,
): Promise<{ members: number; admins: number; healed: boolean; applyHeal: () => void }> {
  const ref = memberCountsRef(companyId)
  const snap = await tx.get(ref)

  if (snap.exists) {
    const data = snap.data()!
    return { members: data.members ?? 0, admins: data.admins ?? 0, healed: false, applyHeal: () => {} }
  }

  const membersCollection = adminDb.collection(`companies/${companyId}/members`)

  // Both aggregate reads run inside this same transaction — see the docblock
  // above for why that, not `Promise.all` outside it, is what keeps this
  // race-free.
  const [membersCountSnap, adminsCountSnap] = await Promise.all([
    tx.get(membersCollection.count()),
    tx.get(membersCollection.where('role', '==', 'admin').count()),
  ])

  const members = membersCountSnap.data().count
  const admins = adminsCountSnap.data().count

  const applyHeal = () => {
    // This absolute merge-set and the FieldValue.increment merge-set
    // `memberCountsDelta` issues right after it (same `ref`, same
    // transaction, on a company's very first write after a heal) are not two
    // independent writes racing on last-write-wins — they COMPOSE. Confirmed
    // empirically (throwaway script against allocate-alpha, deleted after
    // use, same practice as the empirical note in actions/team.ts): inside
    // ONE `Transaction` against the SAME document, an absolute
    // `tx.set(ref, {members:5, admins:3}, {merge:true})` followed by
    // `tx.set(ref, {members: increment(-1), admins: increment(-1)}, {merge:true})`
    // resolves to `{members:4, admins:2}` — the increment lands ON TOP OF the
    // healed value, not instead of it. (The existing note in actions/team.ts
    // only established this for `WriteBatch`; this is the same guarantee for
    // `Transaction`.) This is the assumption the whole applyHeal() +
    // memberCountsDelta() pairing rests on: without it, a company's first
    // counter write after a heal could silently discard either the heal or
    // the delta instead of applying both.
    tx.set(ref, { members, admins, updatedAt: FieldValue.serverTimestamp() }, { merge: true })

    console.warn('[lib/companyStats]', {
      action: 'member_counts_healed',
      companyId,
      members,
      admins,
    })
  }

  return { members, admins, healed: true, applyHeal }
}

/**
 * Applies `delta` to `companies/{id}/_meta/memberCounts` (the authoritative
 * counter `readMemberCounts` reads) AND mirrors the `members` half onto
 * `companies/{id}.stats.memberCount`, via merge-sets on both documents. Never
 * throws.
 *
 * Fields where `delta` is `0` are omitted from the write entirely — not sent
 * as `FieldValue.increment(0)` — so that, for example, `updateMemberRole`'s
 * `{ members: 0, admins: ±1 }` call touches only `admins` and never even
 * references `members`, on either document. This is the enforcement side of
 * the module docblock's footgun note: a bug that accidentally passed a
 * non-zero `members` delta from `updateMemberRole` would still corrupt the
 * counter, but this function at least guarantees a correctly-zeroed delta
 * never writes a spurious `FieldValue.increment(0)` that could be confused
 * for one.
 *
 * `companies/{id}.stats.memberCount` (like every other mirror in this module)
 * has no "authoritative counter that must fail loudly" contract — it is a
 * derived statistic, and a mirror must never be the reason a membership
 * operation fails. This matters concretely for `deleteAccount`
 * (actions/account.ts): the companies it iterates come from the deleted
 * user's own `memberships` documents, which can point at a company doc that
 * no longer exists (a stale pointer — the same class of orphan the
 * equipment-stats PR was cleaning up, just in the other direction).
 * `.update()` throws on a missing document and would fail the entire
 * GDPR-erasure batch over a denormalized counter; `.set(..., { merge: true })`
 * creates the document with just this field instead. `merge: true` on a
 * nested `stats` map merges field-by-field, so `FieldValue.increment` still
 * behaves correctly and sibling stats fields are left untouched, same as
 * every other function in this module. The `_meta/memberCounts` write uses
 * the same merge-set for the same reason, and additionally because
 * `readMemberCounts`'s self-heal branch above may have created that document
 * moments earlier in a sibling transaction — `.update()` would race that.
 *
 * Unlike every other writer here, member count has no writer that runs
 * inside `adminDb.runTransaction` on the Next.js side today — `removeMember`
 * and `deleteAccount` (actions/team.ts, actions/account.ts) both apply their
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
export function memberCountsDelta(
  writer: {
    set(
      documentRef: FirebaseFirestore.DocumentReference,
      data: FirebaseFirestore.PartialWithFieldValue<FirebaseFirestore.DocumentData>,
      options: FirebaseFirestore.SetOptions,
    ): unknown
  },
  companyId: string,
  delta: MemberCountsDelta,
): void {
  if (delta.members === 0 && delta.admins === 0) return

  const countsFields: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }
  if (delta.members !== 0) countsFields.members = FieldValue.increment(delta.members)
  if (delta.admins !== 0) countsFields.admins = FieldValue.increment(delta.admins)

  writer.set(memberCountsRef(companyId), countsFields, { merge: true })

  if (delta.members !== 0) {
    writer.set(
      companyRef(companyId),
      {
        stats: {
          memberCount: FieldValue.increment(delta.members),
          updatedAt: FieldValue.serverTimestamp(),
        },
      },
      { merge: true },
    )
  }
}

/** Initial value for a new company. Written by setupNewCompany's batch. */
export const INITIAL_COMPANY_STATS = {
  equipmentCount: 0,
  bookingsCreated: 0,
  bookingsCancelled: 0,
  lastBookingAt: null,
} as const
