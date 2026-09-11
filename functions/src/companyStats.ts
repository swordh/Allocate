import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';

/**
 * Mirror of `memberCountDelta` in lib/companyStats.ts — that module is the
 * canonical implementation and carries the full contract (every mirrored
 * field must stay recomputable from subcollections; see
 * tools/backfill_company_stats.js).
 *
 * Duplicated here, not imported: lib/companyStats.ts's first line is
 * `import 'server-only'`, which throws when evaluated outside a React Server
 * Component, and it reads `adminDb` from lib/firebase-admin, which in turn
 * needs `FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON` — an env var Cloud Functions
 * never has (they run on Application Default Credentials). This is not a
 * tsconfig/path-mapping problem, so don't try to fix it that way. It's the
 * same functions/-boundary duplication already used for the canonical
 * invite-expiry rule — see the comment in acceptInvitation.ts around where it
 * checks `expiresAt`.
 *
 * Takes `db` as a parameter rather than closing over a module-level
 * `getFirestore()` — Cloud Functions call `getFirestore()` inside the
 * handler, not at module load.
 *
 * Uses a merge-set, not `.update()` — `.update()` throws when the target
 * document doesn't exist, and `memberCount` is a mirror only (no `_meta`
 * counter backs it), so it must never be the reason `acceptInvitation` or
 * `onUserCreate` fails. A missing company doc here would be a genuine
 * anomaly rather than the stale-membership-pointer case that motivates this
 * in lib/companyStats.ts, but the safer behaviour is the same either way: an
 * invitation acceptance should not fail because a stats mirror could not be
 * written. `merge: true` on a nested `stats` map merges field-by-field, so
 * `FieldValue.increment` still behaves correctly and sibling stats fields
 * are left untouched.
 *
 * Only this one function is mirrored. Nothing under functions/src touches
 * `equipmentCount`, `bookingsCreated`, or `bookingsCancelled` today — don't
 * add mirrors for those until something here actually needs to write them.
 *
 * Keep this in lockstep with lib/companyStats.ts's `memberCountDelta`. A
 * change to one without the other is the drift both modules exist to
 * prevent, and the compiler cannot catch it across this boundary.
 */
export function memberCountDelta(
  tx: Transaction,
  db: Firestore,
  companyId: string,
  delta: 1 | -1,
): void {
  tx.set(
    db.doc(`companies/${companyId}`),
    {
      stats: {
        memberCount: FieldValue.increment(delta),
        updatedAt: FieldValue.serverTimestamp(),
      },
    },
    { merge: true },
  );
}
