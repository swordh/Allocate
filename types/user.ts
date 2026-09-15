export type Role = 'admin' | 'crew' | 'viewer'

/**
 * Set on `users/{uid}` by the company purge's "members" phase (issue #252
 * step 5, PR E) when that member has no other company left after the one
 * being deleted. This is a SCHEDULE — the purge itself never deletes the
 * user document, Auth record, or memberships of a stranded member. The
 * account stays fully usable for thirty days: she can sign in, export her
 * data, and create a new company.
 *
 * Absence of this field means nothing is scheduled.
 *
 * Two routes clear this field before its deadline, both in the SAME
 * transaction/batch as the write that gives her a company again, never as a
 * follow-up that could be skipped — "having a company at all is the
 * cancellation condition" ("Avbrottsvillkoret",
 * plan/det-k-nns-som-att-stateless-conway.md):
 *   - `setupNewCompany` (actions/auth.ts) — creating a new company.
 *   - `acceptInvitationByToken` (functions/src/auth/acceptInvitation.ts) —
 *     accepting an invitation into an existing one (issue #252 step 6).
 * A future third route back to having a company must clear it the same way;
 * `strandedAccountSweep` (functions/src/company/strandedAccountSweep.ts,
 * step 6) is the safety net for one that forgets to, not the primary
 * defence — see that file's `hasAnyLiveMembership`.
 *
 * The sweep that actually deletes an account once `scheduledFor` has passed
 * is `strandedAccountSweep` (functions/src/company/strandedAccountSweep.ts,
 * issue #252 step 6). It was deliberately not built until both routes above
 * existed (the plan's "Hård ordningsregel") — that precondition is now met,
 * which is why the sweep is allowed to run. This field is no longer only
 * ever set or cleared: past its deadline, and confirmed live by the sweep as
 * still having no membership anywhere, it is acted on.
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
