import { redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { getCompany } from '@/lib/queries/company'
import { getEquipmentCategoryCounts } from '@/lib/queries/equipment'
import { listMembers } from '@/lib/queries/members'
import { resolveBillingEmailFlag } from '@/lib/billingEmailFlag'
import SubscriptionView from '@/components/settings/SubscriptionView'

export default async function SubscriptionSettingsPage() {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') redirect('/settings/account')

  const [company, categoryCounts, members] = await Promise.all([
    getCompany(session.activeCompanyId),
    getEquipmentCategoryCounts(session.activeCompanyId),
    listMembers(session.activeCompanyId),
  ])

  const equipmentCount = Object.values(categoryCounts).reduce((sum, n) => sum + n, 0)

  // Clears the "billing email missing" flag on the read path — see
  // lib/billingEmailFlag.ts for why the weekly sweep alone isn't enough.
  const billing = await resolveBillingEmailFlag(
    session.activeCompanyId,
    company?.stripeCustomerId,
    company?.billing ?? null,
  )

  return (
    <SubscriptionView
      subscription={company?.subscription ?? null}
      companyName={company?.name ?? ''}
      equipmentCount={equipmentCount}
      memberCount={members.length}
      deletion={company?.deletion ?? null}
      billing={billing}
    />
  )
}
