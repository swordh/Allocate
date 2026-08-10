import Link from 'next/link'
import { getVerifiedSession } from '@/lib/dal'
import { PageHeader } from '@/components/nav/PageHeader'
import SettingsTabs from '@/components/settings/SettingsTabs'
import SettingsSectionMeta from '@/components/settings/SettingsSectionMeta'
import styles from '@/components/settings/settings-shell.module.css'

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await getVerifiedSession()
  const { role } = session

  return (
    <div className={styles.shell}>
      <div className={styles.titleBlock}>
        <PageHeader
          title="Settings"
          size="compact"
          meta={
            <span className={styles.metaMobileOnly}>
              <SettingsSectionMeta />
            </span>
          }
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
