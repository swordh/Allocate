import { getVerifiedSession } from '@/lib/dal'
import { getCompany } from '@/lib/queries/company'
import SubscriptionView from '@/components/settings/SubscriptionView'

/**
 * Settings › Subscription — Server Component.
 * Fetches company data server-side and passes subscription to the client view.
 */
export default async function SubscriptionSettingsPage() {
  const session = await getVerifiedSession()
  const company = await getCompany(session.activeCompanyId)

  return <SubscriptionView subscription={company?.subscription ?? null} />
}
