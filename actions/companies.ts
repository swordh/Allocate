'use server'

import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { listUserCompanies, type UserCompany } from '@/lib/queries/companies'
import { listMembers } from '@/lib/queries/members'
import type { Role } from '@/types'

/**
 * Companies the current user can switch into, for the company switcher UI
 * (issue #352). Thin wrapper, same shape as `getAccountDeletionPreview`
 * (actions/account.ts) — the real work is in `listUserCompanies`.
 */
export async function getSwitchableCompanies(): Promise<UserCompany[]> {
  const session = await getVerifiedSession()
  return listUserCompanies(session.uid)
}

export interface PromotableMember {
  uid: string
  name: string
  email: string
  role: Role
}

export interface LeaveContext {
  /** Bookings the caller made in this company — the leave confirmation names
   *  the number ("The 34 bookings you made stay in …"), so a vague "your
   *  bookings" would be a softer promise than the design makes. */
  bookingCount: number
  /** Everyone except the caller, for the sole-admin successor picker. */
  promotable: PromotableMember[]
}

/**
 * Read-only detail the leave-company flow shows before anything is written
 * (issue #352): the caller's own booking count in `companyId`, and who could
 * take the administrator role over from them.
 *
 * Membership is verified against `users/{uid}/memberships/{companyId}` the
 * same way `switchCompany` (actions/auth.ts) does, rather than trusting
 * `session.activeCompanyId` — the caller may be reading this for a company
 * they belong to but are not currently in (Account Settings lists them all).
 */
export async function getLeaveContext(companyId: string): Promise<LeaveContext> {
  const session = await getVerifiedSession()

  const membershipSnap = await adminDb.doc(`users/${session.uid}/memberships/${companyId}`).get()
  if (!membershipSnap.exists) {
    console.error('[actions/companies]', {
      uid: session.uid.slice(0, 8) + '...',
      companyId,
      action: 'leave_context_denied_no_membership',
    })
    return { bookingCount: 0, promotable: [] }
  }

  const [bookingCountSnap, members] = await Promise.all([
    adminDb.collection(`companies/${companyId}/bookings`).where('userId', '==', session.uid).count().get(),
    listMembers(companyId),
  ])

  return {
    bookingCount: bookingCountSnap.data().count,
    promotable: members
      .filter((m) => m.uid !== session.uid)
      .map((m) => ({ uid: m.uid, name: m.name, email: m.email, role: m.role })),
  }
}
