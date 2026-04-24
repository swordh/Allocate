import 'server-only'

import { cache } from 'react'
import { adminDb } from '@/lib/firebase-admin'
import type { UserProfile } from '@/types'

export const getUserProfile = cache(async (uid: string): Promise<UserProfile | null> => {
  const doc = await adminDb.collection('users').doc(uid).get()
  if (!doc.exists) return null

  const data = doc.data() ?? {}

  return {
    id:                 doc.id,
    name:               data.name               ?? '',
    email:              data.email              ?? '',
    activeCompanyId:    data.activeCompanyId    ?? '',
    defaultBookingView: data.defaultBookingView ?? undefined,
  }
})
