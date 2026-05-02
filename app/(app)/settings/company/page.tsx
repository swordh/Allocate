import { notFound, redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { getCompany } from '@/lib/queries/company'
import { getCategories } from '@/lib/queries/categories'
import CompanySettingsForm from '@/components/settings/CompanySettingsForm'

export default async function CompanySettingsPage() {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') redirect('/settings/account')
  const company = await getCompany(session.activeCompanyId)

  if (!company) {
    notFound()
  }

  const categories = await getCategories(session.activeCompanyId)

  return <CompanySettingsForm name={company.name} categories={categories} />
}
