import { notFound } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { getUserProfile } from '@/lib/queries/users'
import AccountSettingsForm from '@/components/settings/AccountSettingsForm'

export default async function AccountSettingsPage() {
  const session = await getVerifiedSession()
  const profile = await getUserProfile(session.uid)

  if (!profile) notFound()

  return (
    <AccountSettingsForm
      name={profile.name}
      email={session.email}
      defaultBookingView={profile.defaultBookingView}
    />
  )
}
