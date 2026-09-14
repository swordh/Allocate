export type Role = 'admin' | 'crew' | 'viewer'

/**
 * Set on `users/{uid}` by the company purge's "members" phase (issue #252
 * step 5, PR E) when that member has no other company left after the one
 * being deleted. This is a SCHEDULE, not a deletion — the purge itself never
 * deletes the user document, Auth record, or memberships of a stranded
 * member. The account stays fully usable for thirty days: she can sign in,
 * export her data, and create a new company.
 *
 * Absence of this field means nothing is scheduled.
 *
 * `setupNewCompany` (PR F) is the only intended way this field is cleared
 * before its deadline — creating a company means she has a place again, and
 * that clears the field in the SAME transaction as the membership write, not
 * as a follow-up that could be skipped. See "Avbrottsvillkoret" in
 * plan/det-k-nns-som-att-stateless-conway.md.
 *
 * The sweep that actually deletes an account once `scheduledFor` has passed
 * is its own future piece of work — deliberately NOT built in PR E, and not
 * allowed to go live before `setupNewCompany` can clear this field (see the
 * plan's "Hård ordningsregel"). Until that sweep exists, this field can only
 * ever be set or cleared, never acted on.
 */
export interface PendingAccountDeletion {
  scheduledFor: string   // ISO string — thirty days after the triggering company purge's finalize phase
  requestId: string       // the companyDeletions/{requestId} whose purge scheduled this
}

export interface UserProfile {
  id: string
  name: string
  email: string
  activeCompanyId: string
  defaultBookingView?: 'list' | 'week' | 'month' | '4weeks'
  /** See `PendingAccountDeletion` above. Absent means no scheduled deletion. */
  pendingDeletion?: PendingAccountDeletion
}

export interface Membership {
  companyId: string        // field, not just document ID
  role: Role
  joinedAt: string         // ISO string
}

export interface TeamMember {
  uid: string
  name: string
  email: string
  role: Role
  joinedAt: string         // ISO string
}

export interface SessionClaims {
  uid: string
  email: string
  activeCompanyId: string
  role: Role
}
