import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';

/**
 * Duplicated from lib/companyStats.ts's `MemberCountsDelta` — a plain type
 * alias would carry no runtime cost to import, but functions/ is compiled as
 * its own project (`tsconfig.json`'s `include: ["src"]"`) with no path alias
 * back to the repo-level `lib/`, so an import here would be a build-breaking
 * reach outside this compilation unit, not a harmless type-only one. Keep
 * this in lockstep with the canonical definition.
 */
type MemberCountsDelta = { members: -1 | 0 | 1; admins: -1 | 0 | 1 };

/**
 * Mirror of `memberCountsDelta` in lib/companyStats.ts — that module is the
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
 * Uses a merge-set, not `.update()`, on both documents — `.update()` throws
 * when the target document doesn't exist, and neither `_meta/memberCounts`
 * nor the `stats.memberCount` mirror may be the reason `acceptInvitation` or
 * `onUserCreate` fails. A missing company doc here would be a genuine
 * anomaly rather than the stale-membership-pointer case that motivates this
 * in lib/companyStats.ts, but the safer behaviour is the same either way: an
 * invitation acceptance should not fail because a stats mirror could not be
 * written. `merge: true` on a nested `stats` map merges field-by-field, so
 * `FieldValue.increment` still behaves correctly and sibling stats fields
 * are left untouched. Fields where `delta` is `0` are omitted entirely, same
 * as the canonical implementation, so an admin-only delta never touches
 * `members` on either document.
 *
 * `readMemberCounts` (lib/companyStats.ts) is deliberately NOT mirrored here.
 * Nothing under functions/src reads `_meta/memberCounts` today — Cloud
 * Functions only ever increment it, via this function, when `onUserCreate`
 * or `acceptInvitation` adds a member. The rule this module follows (see
 * "Only this one function is mirrored" below) is to mirror what's actually
 * called, not what might be — a mirrored `readMemberCounts` with no caller
 * would be dead code and an extra lockstep surface for no benefit. Add it
 * here only when something under functions/src actually needs to read the
 * counter.
 *
 * Only this one function is mirrored. Nothing under functions/src touches
 * `equipmentCount`, `bookingsCreated`, or `bookingsCancelled` today — don't
 * add mirrors for those until something here actually needs to write them.
 *
 * Keep this in lockstep with lib/companyStats.ts's `memberCountsDelta`. A
 * change to one without the other is the drift both modules exist to
 * prevent, and the compiler cannot catch it across this boundary.
 */
export function memberCountsDelta(
  tx: Transaction,
  db: Firestore,
  companyId: string,
  delta: MemberCountsDelta,
): void {
  if (delta.members === 0 && delta.admins === 0) return;

  const countsFields: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (delta.members !== 0) countsFields.members = FieldValue.increment(delta.members);
  if (delta.admins !== 0) countsFields.admins = FieldValue.increment(delta.admins);

  tx.set(db.doc(`companies/${companyId}/_meta/memberCounts`), countsFields, { merge: true });

  if (delta.members !== 0) {
    tx.set(
      db.doc(`companies/${companyId}`),
      {
        stats: {
          memberCount: FieldValue.increment(delta.members),
          updatedAt: FieldValue.serverTimestamp(),
        },
      },
      { merge: true },
    );
  }
}
