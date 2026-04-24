import { getVerifiedSession } from '@/lib/dal'
import { PageHeader } from '@/components/nav/PageHeader'
import SettingsSecondaryNav from '@/components/nav/SettingsSecondaryNav'

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await getVerifiedSession()

  return (
    <div style={{ maxWidth: '800px', marginLeft: 'auto', marginRight: 'auto' }}>
      <PageHeader title="SETTINGS" nav={<SettingsSecondaryNav role={session.role} />} />
      {children}
    </div>
  )
}
