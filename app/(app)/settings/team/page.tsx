import { redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import TeamSettingsView from '@/components/settings/TeamSettingsView'

export default async function TeamSettingsPage() {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') redirect('/settings/account')

  return (
    <TeamSettingsView
      companyId={session.activeCompanyId}
      currentUserId={session.uid}
    />
  )
}
