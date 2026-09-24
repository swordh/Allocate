import { redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { getCompany } from '@/lib/queries/company'
import { getEquipmentCategoryCounts } from '@/lib/queries/equipment'
import { listMembers } from '@/lib/queries/members'
import { trialHasPaymentMethod } from '@/lib/trialPaymentMethod'
import SubscriptionView from '@/components/settings/SubscriptionView'

export default async function SubscriptionSettingsPage() {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') redirect('/settings/account')

  const company = await getCompany(session.activeCompanyId)

  const [categoryCounts, members, hasPaymentMethod] = await Promise.all([
    getEquipmentCategoryCounts(session.activeCompanyId),
    listMembers(session.activeCompanyId),
    trialHasPaymentMethod(company?.subscription ?? null),
  ])

  const equipmentCount = Object.values(categoryCounts).reduce((sum, n) => sum + n, 0)

  return (
    <SubscriptionView
      subscription={company?.subscription ?? null}
      companyName={company?.name ?? ''}
      equipmentCount={equipmentCount}
      memberCount={members.length}
      deletion={company?.deletion ?? null}
      billing={company?.billing ?? null}
      hasPaymentMethod={hasPaymentMethod}
    />
  )
}
