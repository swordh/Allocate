import 'server-only'

import { FieldValue, type Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase-admin'
import type { CompanyDeletionCancelSource, CompanyDeletionOperatorAction } from '@/types'

/**
 * The writes that turn a `requested` deletion into a cancelled one.
 *
 * Extracted out of `actions/companyDeletion.ts` (which cannot export it
 * directly — a `'use server'` module may only export async functions, and
 * this is synchronous) so `actions/operatorCompanyDeletion.ts` (issue #252
 * step 6, PR 5) can share the EXACT same writes for its own cancel path,
 * rather than re-deriving them and risking drift on the one thing that must
 * never drift: what "cancelled" means on the ledger and the mirror.
 *
 * `FieldValue.delete()` on `deletion`, rather than a `state: 'canceled'`
 * value on it, is the data model's own rule: absence of the field is the ONLY
 * "nothing is going on" signal, so every reader — the sweep's query, the
 * banner, `docToCompany` — gets the right answer without learning a new
 * state. See the docblock on `CompanyDeletionState` in types/company.ts.
 *
 * `operatorActions`, when passed, REPLACES the array on the ledger wholesale
 * — callers pass the full array (existing entries plus their new one), not a
 * delta, matching the read-modify-write convention already used for
 * `formerMemberContacts` in functions/src/company/purge.ts's members phase.
 * Only the operator cancel path passes this; the two customer-facing callers
 * (`cancelCompanyDeletion`, `cancelCompanyDeletionByToken`) never do, so their
 * writes are byte-for-byte what they always were.
 */
export function applyCancelWrites(
  tx: FirebaseFirestore.Transaction,
  companyId: string,
  requestId: string,
  now: Timestamp,
  source: CompanyDeletionCancelSource,
  identity: { uid?: string; name: string; email?: string },
  operatorActions?: CompanyDeletionOperatorAction[],
): void {
  tx.update(adminDb.doc(`companies/${companyId}`), { deletion: FieldValue.delete() })
  tx.update(adminDb.doc(`companyDeletions/${requestId}`), {
    state: 'canceled',
    canceledAt: now,
    canceledByName: identity.name,
    ...(identity.uid ? { canceledByUid: identity.uid } : {}),
    ...(identity.email ? { canceledByEmail: identity.email } : {}),
    cancelSource: source,
    ...(operatorActions ? { operatorActions } : {}),
  })
}
