import 'server-only'

import { cache } from 'react'
import { adminDb } from '@/lib/firebase-admin'
import type { TeamMember } from '@/types'

function docToMember(doc: FirebaseFirestore.DocumentSnapshot): TeamMember {
  const data = doc.data() ?? {}
  return {
    uid:      data.uid  ?? doc.id,
    name:     data.name ?? '',
    email:    data.email ?? '',
    role:     data.role ?? 'crew',
    joinedAt: data.joinedAt?.toDate?.()?.toISOString() ?? data.joinedAt ?? '',
  }
}

/**
 * One-shot fetch of a company's members, sorted by joinedAt ascending.
 *
 * `joinedAt` is stored as a Firestore Timestamp by every writer
 * (actions/auth.ts, functions/src/auth/onUserCreate.ts,
 * functions/src/auth/acceptInvitation.ts) and is converted to an ISO
 * string here — Timestamp instances are not serializable across the
 * server→client component boundary.
 *
 * Sorting happens in memory rather than via `.orderBy('joinedAt')` on
 * the query: Firestore excludes documents that lack the ordered field
 * from the result set entirely, so any member doc missing `joinedAt`
 * would silently disappear from the team list instead of just sorting
 * last. The collection is small (bounded by plan limits, max 30
 * members), so the in-memory sort is cheap.
 */
export const listMembers = cache(async (companyId: string): Promise<TeamMember[]> => {
  const snapshot = await adminDb
    .collection(`companies/${companyId}/members`)
    .get()

  return snapshot.docs
    .map(docToMember)
    .sort((a, b) => {
      if (!a.joinedAt) return 1
      if (!b.joinedAt) return -1
      return a.joinedAt.localeCompare(b.joinedAt)
    })
})
