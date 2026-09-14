import 'server-only'

import { cache } from 'react'
import { adminDb } from '@/lib/firebase-admin'
import type { UserProfile } from '@/types'

export const getUserProfile = cache(async (uid: string): Promise<UserProfile | null> => {
  const doc = await adminDb.collection('users').doc(uid).get()
  if (!doc.exists) return null

  const data = doc.data() ?? {}

  // TODO(#252 step 5, PR F): `pendingDeletion` (types/user.ts) is not mapped
  // here yet — same silent-drop trap `docToCompany` had for `stats` before
  // it was fixed (see lib/queries/company.ts's docblock on that function).
  // A field existing on the `UserProfile` type does not make it reach any
  // caller of `getUserProfile` until it's mapped here too. PR F needs this
  // mapped before it can build the "logged in with no company" screen for a
  // stranded member — she can't be shown her countdown from a field this
  // function silently strips.
  return {
    id:                 doc.id,
    name:               data.name               ?? '',
    email:              data.email              ?? '',
    activeCompanyId:    data.activeCompanyId    ?? '',
    defaultBookingView: data.defaultBookingView ?? undefined,
  }
})
