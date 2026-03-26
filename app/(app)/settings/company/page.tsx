import { notFound } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { getCompany } from '@/lib/queries/company'
import CompanySettingsForm from '@/components/settings/CompanySettingsForm'

/**
 * Settings › Company — Server Component.
 * Fetches company data server-side and passes it to the client form.
 */
export default async function CompanySettingsPage() {
  const session = await getVerifiedSession()
  const company = await getCompany(session.activeCompanyId)

  if (!company) {
    notFound()
  }

  return <CompanySettingsForm name={company.name} />
}
