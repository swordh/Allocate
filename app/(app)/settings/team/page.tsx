import { redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { adminDb } from '@/lib/firebase-admin'
import { listMembers } from '@/lib/queries/members'
import { computeSeatsUsed } from '@/lib/invite-recipients'
import TeamSettingsView from '@/components/settings/TeamSettingsView'
import type { Invitation, PublicInvitation } from '@/types/invitation'

export default async function TeamSettingsPage() {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') redirect('/settings/account')

  // Server-side read — no client-side Firestore listener, which would need
  // its own security rules for a collection the client otherwise never lists.
  const [pendingSnap, members, companySnap] = await Promise.all([
    adminDb
      .collection(`companies/${session.activeCompanyId}/invitations`)
      .where('status', '==', 'pending')
      .get(),
    listMembers(session.activeCompanyId),
    adminDb.doc(`companies/${session.activeCompanyId}`).get(),
  ])

  // `token` is the credential embedded in the accept link — it must never
  // reach the client payload. Destructure it off explicitly (not just cast
  // away) so it is actually absent from what gets serialized to the Client
  // Component, not merely untyped.
  const pendingInvitesFull = pendingSnap.docs.map((doc) => doc.data() as Invitation)
  const pendingInvites: PublicInvitation[] = pendingInvitesFull.map(
    ({ token: _token, ...publicInvite }) => publicInvite,
  )

  // Seat count shown in the UI must match what `inviteUsers`'s seat guard
  // (actions/team.ts) actually enforces: members + PENDING invitations that
  // have not expired. Shared with the server via `computeSeatsUsed` so the
  // page and the guard can't drift.
  const seatsUsed = computeSeatsUsed(members.length, pendingInvites)

  const seatLimit = (companySnap.data()?.subscription?.limits?.users as number | undefined) ?? null

  return (
    <TeamSettingsView
      currentUserId={session.uid}
      pendingInvites={pendingInvites}
      members={members}
      seatsUsed={seatsUsed}
      seatLimit={seatLimit}
    />
  )
}
