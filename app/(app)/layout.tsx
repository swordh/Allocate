import { redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { adminDb } from '@/lib/firebase-admin'
import PrimaryNav from '@/components/nav/PrimaryNav'
import { MobileBottomNav } from '@/components/nav/MobileBottomNav'
import styles from './app-layout.module.css'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getVerifiedSession()

  const companyDoc = await adminDb.doc(`companies/${session.activeCompanyId}`).get()
  const companyData = companyDoc.data()
  const subStatus = companyData?.subscription?.status
  const stripeCustomerId = companyData?.stripeCustomerId ?? ''

  // Block access if canceled, or if trialing without a real Stripe subscription
  // (trialing + no stripeCustomerId = auto-trial from signup, never converted)
  const needsSubscription =
    subStatus === 'canceled' ||
    (subStatus === 'trialing' && !stripeCustomerId)

  if (needsSubscription) redirect('/subscribe')

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
