import 'server-only'

import { cache } from 'react'
import { adminDb } from '@/lib/firebase-admin'
import type { Company } from '@/types'

function docToCompany(doc: FirebaseFirestore.DocumentSnapshot): Company {
  const data = doc.data() ?? {}

  const subscription = data.subscription ?? {}
  const mappedSubscription = {
    status:             subscription.status             ?? 'trialing',
    plan:               subscription.plan               ?? 'starter',
    currentPeriodEnd:   subscription.currentPeriodEnd?.toDate?.()?.toISOString()
                          ?? subscription.currentPeriodEnd
                          ?? '',
    limits:             subscription.limits             ?? { equipment: 0, users: 0 },
    trialEnd:           subscription.trialEnd?.toDate?.()?.toISOString()
                          ?? subscription.trialEnd
                          ?? undefined,
    cancelAtPeriodEnd:  subscription.cancelAtPeriodEnd  ?? undefined,
    interval:           subscription.interval           ?? undefined,
  }

  const prefs = data.preferences
  const preferences = prefs
    ? {
        bookingTimeSlotMinutes: prefs.bookingTimeSlotMinutes ?? 15,
        autoCheckout:           prefs.autoCheckout           ?? false,
        autoCheckin:            prefs.autoCheckin            ?? false,
        defaultBookingView:     prefs.defaultBookingView     ?? 'list',
        timezone:               typeof prefs.timezone === 'string' ? prefs.timezone : 'UTC',
      }
    : undefined

  return {
    id:               doc.id,
    name:             data.name             ?? '',
    createdAt:        data.createdAt?.toDate?.()?.toISOString() ?? data.createdAt ?? '',
    createdBy:        data.createdBy        ?? '',
    stripeCustomerId: data.stripeCustomerId ?? '',
    subscription:     mappedSubscription,
    preferences,
  }
}

/**
 * Fetches a company document by ID.
 * Full implementation in Phase 2.
 */
export const getCompany = cache(async (companyId: string): Promise<Company | null> => {
  const doc = await adminDb.collection('companies').doc(companyId).get()
  if (!doc.exists) return null
  return docToCompany(doc)
})
