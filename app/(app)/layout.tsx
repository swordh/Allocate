import { redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { adminDb } from '@/lib/firebase-admin'
import PrimaryNav from '@/components/nav/PrimaryNav'
import { MobileBottomNav } from '@/components/nav/MobileBottomNav'
import styles from './app-layout.module.css'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getVerifiedSession()

  const companyDoc = await adminDb.doc(`companies/${session.activeCompanyId}`).get()
  const subStatus = companyDoc.data()?.subscription?.status
  if (subStatus === 'canceled') redirect('/subscribe')

  return (
    <div data-role={session.role} data-company={session.activeCompanyId}>
      <PrimaryNav role={session.role} />
      <main className={styles.main}>
        {children}
      </main>
      <MobileBottomNav role={session.role} />
    </div>
  )
}
