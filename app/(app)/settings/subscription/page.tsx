import { redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { getCompany } from '@/lib/queries/company'
import { getEquipmentCategoryCounts } from '@/lib/queries/equipment'
import { listMembers } from '@/lib/queries/members'
import { trialHasPaymentMethod } from '@/lib/trialPaymentMethod'
import { resolveBillingEmailFlag } from '@/lib/billingEmailFlag'
import SubscriptionView from '@/components/settings/SubscriptionView'

export default async function SubscriptionSettingsPage() {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') redirect('/settings/account')

  const company = await getCompany(session.activeCompanyId)

  // resolveBillingEmailFlag clears the "billing email missing" flag on the
  // read path — see lib/billingEmailFlag.ts for why the weekly sweep alone
  // isn't enough. Both Stripe lookups only depend on `company`, so they run
  // alongside the other reads.
  const [categoryCounts, members, hasPaymentMethod, billing] = await Promise.all([
    getEquipmentCategoryCounts(session.activeCompanyId),
    listMembers(session.activeCompanyId),
    trialHasPaymentMethod(company?.subscription ?? null),
    resolveBillingEmailFlag(session.activeCompanyId, company?.stripeCustomerId, company?.billing ?? null),
  ])

  const equipmentCount = Object.values(categoryCounts).reduce((sum, n) => sum + n, 0)

  return (
    <SubscriptionView
      subscription={company?.subscription ?? null}
      companyName={company?.name ?? ''}
      equipmentCount={equipmentCount}
      memberCount={members.length}
      deletion={company?.deletion ?? null}
      billing={billing}
      hasPaymentMethod={hasPaymentMethod}
      // Issue #361 — same pattern as CompanySettingsForm's `initialTimezone`
      // prop (app/(app)/settings/company/page.tsx): the company's own zone,
      // for rendering `deletion.scheduledFor` in `getSubStateDisplay`'s
      // DELETION_PENDING notice, not the admin's browser zone.
      timezone={company?.preferences?.timezone}
    />
  )
}
