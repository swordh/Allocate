import Link from 'next/link'
import { getVerifiedSession, getCompanyDoc } from '@/lib/dal'
import { hasFullAccess } from '@/lib/subscriptionAccess'
import { PageHeader } from '@/components/nav/PageHeader'
import SettingsTabs from '@/components/settings/SettingsTabs'
import SettingsSectionMeta from '@/components/settings/SettingsSectionMeta'
import styles from '@/components/settings/settings-shell.module.css'

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await getVerifiedSession()
  const { role } = session

  // Issue #350 (GDPR) — same Firestore read `app/(app)/layout.tsx` already
  // made for this request (getCompanyDoc is React.cache()-wrapped, see its
  // own docblock in lib/dal.ts), so this costs nothing extra. Needed here,
  // separately from the parent layout, because SettingsTabs must never
  // render a tab that the parent's `evaluateAppAccess` gate would then
  // reject — see settingsItemsFor's docblock in components/nav/nav-items.ts.
  const companyDoc = await getCompanyDoc(session.activeCompanyId)
  const subscription = companyDoc.data()?.subscription
  const fullAccess = hasFullAccess(subscription?.status, subscription?.trialEnd ?? null)

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
              <SettingsTabs role={role} hasFullAccess={fullAccess} />
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
