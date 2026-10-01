import { createHmac } from 'crypto';
import { defineSecret } from 'firebase-functions/params';

/**
 * Issue #294: `deletionAuditLog.userIdHash` used to be `sha256(uid)` with no
 * key. An unsalted, unkeyed hash of a value (the uid) that already appears
 * in plaintext elsewhere in this system (Firebase Auth, `users/{uid}`, every
 * other Firestore doc keyed by uid) is not pseudonymisation — anyone who can
 * enumerate uids (which this project's own Admin SDK access already lets an
 * operator do) can rebuild the same hash and match it straight back to a
 * person. HMAC-SHA256 keyed with a secret that never appears alongside the
 * uid closes that: the hash can no longer be recomputed by an outside party,
 * only compared against rows already in `deletionAuditLog`.
 *
 * This does NOT make `userIdHash` anonymous data. It is still personal data
 * under GDPR (pseudonymisation, not anonymisation — Recital 26): anyone
 * holding both the key and a uid can still link a row back to that person.
 * That is exactly why `deletionAuditLog` still ages out under the 12-month
 * retention rule (see `functions/src/admin/purgeAuditLogs.ts`) instead of
 * being treated as free of GDPR obligations.
 *
 * Mirror of `lib/auditLogHash.ts` — `functions/` compiles as its own project
 * with no path alias back to the repo root, so this can't be imported, only
 * kept in lockstep by hand. Both read the SAME `AUDIT_LOG_HMAC_KEY` secret
 * value (see apphosting.yaml / this function's own `secrets:` bindings) so a
 * hash computed by the webapp and one computed by a Cloud Function are
 * comparable in Firestore queries.
 *
 * `AUDIT_LOG_HMAC_KEY` is exported here (rather than kept private) so every
 * trigger that calls `hashUserIdForAudit` can bind it into its own
 * `secrets:` array — Cloud Functions only makes a secret's value available
 * to an invocation whose trigger declared it there.
 */
export const AUDIT_LOG_HMAC_KEY = defineSecret('AUDIT_LOG_HMAC_KEY');

export function hashUserIdForAudit(uid: string): string {
  const key = process.env.AUDIT_LOG_HMAC_KEY;
  if (!key) {
    throw new Error('[audit/userIdHash] AUDIT_LOG_HMAC_KEY is not set');
  }
  return createHmac('sha256', key).update(uid).digest('hex');
}
