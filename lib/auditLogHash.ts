import 'server-only'

import { createHmac } from 'crypto'

/**
 * Issue #294: `deletionAuditLog.userIdHash` used to be `sha256(uid)` with no
 * key. An unsalted, unkeyed hash of a value (the uid) that already appears
 * in plaintext elsewhere in this system (Firebase Auth, `users/{uid}`,
 * every other Firestore doc keyed by uid) is not pseudonymisation — anyone
 * who can enumerate uids (which this app's own Admin SDK access already
 * lets an operator do) can rebuild the same hash and match it straight back
 * to a person. HMAC-SHA256 keyed with a secret that never appears alongside
 * the uid closes that: the hash can no longer be recomputed by an outside
 * party, only compared against rows already in `deletionAuditLog`.
 *
 * This does NOT make `userIdHash` anonymous data. It is still personal data
 * under GDPR (pseudonymisation, not anonymisation — Recital 26): anyone
 * holding both the key and a uid can still link a row back to that person.
 * That is exactly why `deletionAuditLog` still ages out under the 12-month
 * retention rule (see `functions/src/admin/purgeAuditLogs.ts`) instead of
 * being treated as free of GDPR obligations.
 *
 * Mirror of `functions/src/audit/userIdHash.ts` — `functions/` compiles as
 * its own project with no path alias back to the repo root, so this can't
 * be shared by import, only kept in lockstep by hand. Both read the SAME
 * `AUDIT_LOG_HMAC_KEY` secret value (see apphosting.yaml / the functions
 * `secrets:` bindings) so a hash computed by the webapp and one computed by
 * a Cloud Function are comparable in Firestore queries.
 */
export function hashUserIdForAudit(uid: string): string {
  const key = process.env.AUDIT_LOG_HMAC_KEY
  if (!key) {
    throw new Error('[auditLogHash] AUDIT_LOG_HMAC_KEY is not set')
  }
  return createHmac('sha256', key).update(uid).digest('hex')
}
