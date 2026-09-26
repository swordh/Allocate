import 'server-only'

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase-admin'

/** How long an `operatorLoginLog/{id}` row survives — the doc's `expireAt`
 *  TTL field, set once at write time (this collection is append-only, unlike
 *  `accountDeletionFailures`'s per-uid overwrite). */
const OPERATOR_LOGIN_LOG_TTL_MS = 365 * 24 * 60 * 60 * 1000

export type OperatorLoginOutcome = 'granted' | 'denied'

/**
 * Append-only audit row at `operatorLoginLog/{id}` (issue #344) — every
 * attempt to authenticate against `/operator/login`, both the operators who
 * get in and the customers/strangers who try and don't. Admin SDK only, see
 * `firestore.rules`. 12-month TTL via `expireAt`.
 *
 * Deliberately does NOT record IP or user agent — uid + email + outcome +
 * reason is the whole point (who tried, what happened, why), and nothing
 * else is needed for the security/audit purpose this collection exists for.
 *
 * The caller (`actions/operator-auth.ts` → `operatorSignIn`) always awaits
 * this — a Server Action's process can be torn down the instant it returns
 * a value to the client, and "no access without an audit trail" means the
 * write has to have actually landed (or definitively failed) before that
 * function decides whether to grant access at all. See `operatorSignIn`'s
 * own docblock for how a `granted` write failure turns into a denial.
 */
export async function writeOperatorLoginLog(params: {
  uid: string
  email: string
  outcome: OperatorLoginOutcome
  reason: string
}): Promise<void> {
  const now = Timestamp.now()
  const expireAt = Timestamp.fromMillis(now.toMillis() + OPERATOR_LOGIN_LOG_TTL_MS)

  await adminDb.collection('operatorLoginLog').add({
    uid:     params.uid,
    email:   params.email,
    outcome: params.outcome,
    reason:  params.reason,
    at:      FieldValue.serverTimestamp(),
    expireAt,
  })
}
