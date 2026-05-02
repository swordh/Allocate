import { redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { getCompany } from '@/lib/queries/company'
import SubscriptionView from '@/components/settings/SubscriptionView'

export default async function SubscriptionSettingsPage() {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') redirect('/settings/account')
  const company = await getCompany(session.activeCompanyId)

  return <SubscriptionView subscription={company?.subscription ?? null} />
}
