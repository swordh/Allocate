import 'server-only'

import { cache } from 'react'
import { adminDb } from '@/lib/firebase-admin'
import type { UserProfile } from '@/types'

/**
 * Normalises whatever `pendingDeletion.scheduledFor` actually holds into an
 * ISO string, or into the empty string when it holds nothing usable.
 *
 * The purge's members phase (functions/src/company/memberCleanup.ts) writes
 * a Firestore Timestamp, and `PendingAccountDeletion.scheduledFor`
 * (types/user.ts) is documented as an ISO string — so the ordinary path is
 * the `.toDate().toISOString()` conversion `docToCompany`
 * (lib/queries/company.ts) already uses for `deletion`/`stats`.
 *
 * Everything else is a guard, not a supported shape. No current writer
 * produces a present-but-null, empty, or non-Timestamp `scheduledFor`, but
 * nothing structurally prevents one either, and an unguarded value flows
 * straight into `new Date(...)` on the /no-company screen, where it renders
 * as "NaN days left" — a nonsense sentence on the one screen whose whole
 * job is telling a stranded user the truth about her account. The empty
 * string returned here is what `pendingDeletionCountdown`
 * (lib/pendingDeletionCountdown.ts) turns into `{ kind: 'unknown' }`: no
 * countdown rather than a broken one.
 */
function toIsoStringOrEmpty(value: unknown): string {
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    const date = (value as { toDate: () => Date }).toDate()
    return Number.isFinite(date?.getTime?.()) ? date.toISOString() : ''
  }
  if (typeof value === 'string' && Number.isFinite(new Date(value).getTime())) {
    return value
  }
  return ''
}

export const getUserProfile = cache(async (uid: string): Promise<UserProfile | null> => {
  const doc = await adminDb.collection('users').doc(uid).get()
  if (!doc.exists) return null

  const data = doc.data() ?? {}

  // A field only declared on the `UserProfile` type reaches no caller of
  // `getUserProfile` until it is mapped here too — this function maps the
  // raw document field by field, the same silent-drop trap `docToCompany`
  // had for `stats`.
  const pendingDeletionData = data.pendingDeletion
  const pendingDeletion = pendingDeletionData
    ? {
        scheduledFor: toIsoStringOrEmpty(pendingDeletionData.scheduledFor),
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
