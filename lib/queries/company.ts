import 'server-only'

import { cache } from 'react'
import { adminDb } from '@/lib/firebase-admin'
import type { Company, CompanyStats } from '@/types'

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
    pauseCollection:    subscription.pauseCollection    ?? null,
    pauseResumesAt:     subscription.pauseResumesAt?.toDate?.()?.toISOString()
                          ?? subscription.pauseResumesAt
                          ?? null,
  }

  // #252 step 5 prep: `stats` is written by lib/companyStats.ts but was never
  // read back here — a company's stats mirror reached every writer and no
  // reader via getCompany(). Same silent-drop shape as `deletion` will be:
  // a field that exists only in the type is not the same as a field that
  // exists in the returned object.
  const stats = data.stats
  const mappedStats: CompanyStats | undefined = stats
    ? {
        equipmentCount:     stats.equipmentCount     ?? 0,
        bookingsCreated:    stats.bookingsCreated    ?? 0,
        bookingsCancelled:  stats.bookingsCancelled  ?? 0,
        lastBookingAt:      stats.lastBookingAt?.toDate?.()?.toISOString()
                              ?? stats.lastBookingAt
                              ?? null,
        memberCount:        stats.memberCount        ?? 0,
        updatedAt:          stats.updatedAt?.toDate?.()?.toISOString()
                              ?? stats.updatedAt
                              ?? '',
      }
    : undefined

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

  // `deletion` (issue #252) mirrors companies/{cid}.deletion so members can see
  // a scheduled deletion's end date — see the docblock on CompanyDeletion in
  // types/company.ts for why it lives on this document at all.
  //
  // READ THIS BEFORE ADDING ANOTHER FIELD TO THE `Company` TYPE: this function
  // maps the raw Firestore document field by field. Adding something to the
  // `Company` interface in types/company.ts does NOT make it reach any caller
  // of `getCompany` — it has to be mapped here too, or it is silently
  // `undefined` everywhere. That already happened once: `stats` has existed
  // on `Company` without being mapped here. Don't repeat it for the next field.
  const deletionData = data.deletion
  const deletion = deletionData
    ? {
        state:            deletionData.state,
        requestId:        deletionData.requestId,
        requestedAt:      deletionData.requestedAt?.toDate?.()?.toISOString() ?? deletionData.requestedAt ?? '',
        requestedByName:  deletionData.requestedByName ?? '',
        scheduledFor:     deletionData.scheduledFor?.toDate?.()?.toISOString() ?? deletionData.scheduledFor ?? '',
        mode:             deletionData.mode,
        remindedAt:       deletionData.remindedAt?.toDate?.()?.toISOString() ?? deletionData.remindedAt ?? undefined,
        claimedAt:        deletionData.claimedAt?.toDate?.()?.toISOString() ?? deletionData.claimedAt ?? undefined,
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
    stats:            mappedStats,
    deletion,
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
