import 'server-only'

import { cache } from 'react'
import { adminDb } from '@/lib/firebase-admin'
import type { UserProfile } from '@/types'

export const getUserProfile = cache(async (uid: string): Promise<UserProfile | null> => {
  const doc = await adminDb.collection('users').doc(uid).get()
  if (!doc.exists) return null

  const data = doc.data() ?? {}

  // `pendingDeletion` is written by the company purge's members phase
  // (functions/src/company/memberCleanup.ts) as a Firestore Timestamp, but
  // `PendingAccountDeletion.scheduledFor` (types/user.ts) is documented as
  // an ISO string — same `.toDate?.()?.toISOString()` pattern
  // lib/queries/company.ts's `docToCompany` already uses for `deletion`/
  // `stats`, for the same reason: this function maps the raw document field
  // by field, and a field only declared on the `UserProfile` type reaches
  // no caller of `getUserProfile` until it's mapped here too.
  const pendingDeletionData = data.pendingDeletion
  const pendingDeletion = pendingDeletionData
    ? {
        scheduledFor: pendingDeletionData.scheduledFor?.toDate?.()?.toISOString()
                        ?? pendingDeletionData.scheduledFor
                        ?? '',
        requestId:    pendingDeletionData.requestId ?? '',
      }
    : undefined

  return {
    id:                 doc.id,
    name:               data.name               ?? '',
    email:              data.email              ?? '',
    activeCompanyId:    data.activeCompanyId    ?? '',
    defaultBookingView: data.defaultBookingView ?? undefined,
    pendingDeletion,
  }
})
