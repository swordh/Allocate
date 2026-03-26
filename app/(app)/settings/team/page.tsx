import { getVerifiedSession } from '@/lib/dal'
import TeamSettingsView from '@/components/settings/TeamSettingsView'

/**
 * Settings › Team — Server Component.
 * Passes companyId and currentUserId from the verified session to the client view.
 */
export default async function TeamSettingsPage() {
  const session = await getVerifiedSession()

  return (
    <TeamSettingsView
      companyId={session.activeCompanyId}
      currentUserId={session.uid}
    />
  )
}
