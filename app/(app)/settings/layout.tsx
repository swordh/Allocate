import Link from 'next/link'
import { getVerifiedSession } from '@/lib/dal'
import { getCompany } from '@/lib/queries/company'
import { adminDb } from '@/lib/firebase-admin'
import { PLAN_CATALOG, type PlanId } from '@/lib/plans'
import { PageHeader } from '@/components/nav/PageHeader'
import SettingsTabs from '@/components/settings/SettingsTabs'
import styles from '@/components/settings/settings-shell.module.css'

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await getVerifiedSession()
  const { activeCompanyId, role } = session

  const [company, memberCountSnap] = await Promise.all([
    getCompany(activeCompanyId),
    adminDb.collection(`companies/${activeCompanyId}/members`).count().get(),
  ])

  const memberCount = memberCountSnap.data().count
  const planId = (company?.subscription?.plan ?? 'starter') as PlanId
  const planLabel = (PLAN_CATALOG[planId]?.name ?? 'Starter').toUpperCase()
  const companyName = company?.name ?? ''
  const meta = `${companyName} · ${planLabel} PLAN · ${memberCount} MEMBER${memberCount === 1 ? '' : 'S'}`

  return (
    <div className={styles.shell}>
      <div className={styles.titleBlock}>
        <PageHeader
          title="Settings"
          size="compact"
          meta={meta}
          nav={
            <div className={styles.tabRow}>
              <SettingsTabs role={role} />
            </div>
          }
        />
      </div>
      <div className={styles.scrollArea}>
        {children}
        <div className={styles.footer}>
          <span className={styles.footerSpacer} />
          <Link href="/terms" className={styles.footerLink}>
            TERMS OF SERVICE
          </Link>
          <Link href="/privacy" className={styles.footerLink}>
            PRIVACY POLICY
          </Link>
        </div>
      </div>
    </div>
  )
}
