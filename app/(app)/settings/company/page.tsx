import { notFound, redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { getCompany } from '@/lib/queries/company'
import { getCategories } from '@/lib/queries/categories'
import { getEquipmentCategoryCounts } from '@/lib/queries/equipment'
import CompanySettingsForm from '@/components/settings/CompanySettingsForm'

export default async function CompanySettingsPage() {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') redirect('/settings/account')
  const company = await getCompany(session.activeCompanyId)

  if (!company) {
    notFound()
  }

  // "<n> TYPES" per category — count of equipment docs (types), not units.
  // Includes inactive equipment: the category delete confirmation warns that
  // assigned equipment keeps its category reference, so the count must not
  // hide inactive items behind a false "0 TYPES".
  const [categories, typeCounts] = await Promise.all([
    getCategories(session.activeCompanyId),
    getEquipmentCategoryCounts(session.activeCompanyId),
  ])

  return (
    <CompanySettingsForm
      name={company.name}
      categories={categories}
      typeCounts={typeCounts}
      timezone={company.preferences?.timezone}
    />
  )
}
