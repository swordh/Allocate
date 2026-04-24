import { redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { getCompany } from '@/lib/queries/company'
import { DEFAULT_COMPANY_PREFERENCES } from '@/constants/company'
import PreferencesForm from '@/components/settings/PreferencesForm'

export default async function PreferencesSettingsPage() {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') redirect('/settings/account')

  const company = await getCompany(session.activeCompanyId)

  return <PreferencesForm preferences={company?.preferences ?? DEFAULT_COMPANY_PREFERENCES} />
}
