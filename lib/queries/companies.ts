import 'server-only'

import { adminDb } from '@/lib/firebase-admin'

export interface UserCompany {
  id: string
  name: string
}

/**
 * The companies a user can switch into — id + name only. Deliberately
 * lighter than `getDeletionOutcomes` (lib/queries/deletionOutcomes.ts):
 * the switcher never needs member/admin counts, and reading
 * `_meta/memberCounts` (or its aggregate fallback) for every company on
 * every menu open would be a wasted Firestore read for data nobody sees.
 *
 * A membership doc whose company has since been deleted is skipped, not
 * reported — same reasoning `getDeletionOutcomes` already documents for the
 * identical stale-pointer case.
 */
export async function listUserCompanies(uid: string): Promise<UserCompany[]> {
  const membershipsSnap = await adminDb.collection(`users/${uid}/memberships`).get()

  const results = await Promise.all(
    membershipsSnap.docs.map(async (membershipDoc): Promise<UserCompany | null> => {
      const companyId = membershipDoc.data().companyId as string

      let companySnap: FirebaseFirestore.DocumentSnapshot
      try {
        companySnap = await adminDb.doc(`companies/${companyId}`).get()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[lib/queries/companies]', { companyId, error: message, action: 'company_read_failed' })
        return null
      }

      if (!companySnap.exists) return null

      const name = (companySnap.data()?.name as string | undefined) ?? ''
      return { id: companyId, name }
    }),
  )

  return results.filter((r): r is UserCompany => r !== null)
}
