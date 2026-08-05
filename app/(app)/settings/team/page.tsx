import { redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { adminDb } from '@/lib/firebase-admin'
import TeamSettingsView from '@/components/settings/TeamSettingsView'
import type { Invitation } from '@/types/invitation'

export default async function TeamSettingsPage() {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') redirect('/settings/account')

  // Server-side read — no client-side Firestore listener, which would need
  // its own security rules for a collection the client otherwise never lists.
  const pendingSnap = await adminDb
    .collection(`companies/${session.activeCompanyId}/invitations`)
    .where('status', '==', 'pending')
    .get()

  const pendingInvites = pendingSnap.docs.map((doc) => doc.data() as Invitation)

  return (
    <TeamSettingsView
      companyId={session.activeCompanyId}
      currentUserId={session.uid}
      pendingInvites={pendingInvites}
    />
  )
}
