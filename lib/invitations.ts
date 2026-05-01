import 'server-only'

import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import type { SessionClaims } from '@/types'

/**
 * Returns the caller's session and asserts they are an owner or admin.
 * Throws a plain Error (caught and returned as { error }) if not.
 */
export async function getCallerMembership(): Promise<SessionClaims & { companyId: string }> {
  const session = await getVerifiedSession()

  if (session.role !== 'admin') {
    throw new Error('Unauthorized — only admins can manage invitations')
  }

  return { ...session, companyId: session.activeCompanyId }
}

/**
 * Finds the first pending invitation for the given email in a company.
 * Returns the doc snapshot or null.
 */
export async function findPendingByEmail(
  companyId: string,
  email: string,
): Promise<FirebaseFirestore.QueryDocumentSnapshot | null> {
  const snap = await adminDb
    .collection(`companies/${companyId}/invitations`)
    .where('email', '==', email)
    .where('status', '==', 'pending')
    .limit(1)
    .get()

  return snap.empty ? null : snap.docs[0]
}
