import { redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { adminDb } from '@/lib/firebase-admin'
import { listMembers } from '@/lib/queries/members'
import TeamSettingsView from '@/components/settings/TeamSettingsView'
import type { Invitation } from '@/types/invitation'

export default async function TeamSettingsPage() {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') redirect('/settings/account')

  // Server-side read — no client-side Firestore listener, which would need
  // its own security rules for a collection the client otherwise never lists.
  const [pendingSnap, members] = await Promise.all([
    adminDb
      .collection(`companies/${session.activeCompanyId}/invitations`)
      .where('status', '==', 'pending')
      .get(),
    listMembers(session.activeCompanyId),
  ])

  const pendingInvites = pendingSnap.docs.map((doc) => doc.data() as Invitation)

  return (
    <TeamSettingsView
      currentUserId={session.uid}
      pendingInvites={pendingInvites}
      members={members}
    />
  )
}
