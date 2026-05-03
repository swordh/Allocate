import { redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { adminDb } from '@/lib/firebase-admin'
import PrimaryNav from '@/components/nav/PrimaryNav'
import { MobileMenu } from '@/components/nav/MobileMenu'
import styles from './app-layout.module.css'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getVerifiedSession()

  const companyDoc = await adminDb.doc(`companies/${session.activeCompanyId}`).get()
  if (!companyDoc.exists) {
    console.error('[layout] company document not found', { companyId: session.activeCompanyId })
    redirect('/subscribe')
  }

  const companyData = companyDoc.data()
  const subStatus = companyData?.subscription?.status
  const trialEnd = companyData?.subscription?.trialEnd ?? null

  // Allow: active subscription, or a real Stripe trial (trialEnd is set by webhook on subscription.created)
  // Block: initial auto-trial (trialEnd=null), abandoned checkout, past_due, canceled
  const isRealTrial = subStatus === 'trialing' && trialEnd !== null
  if (subStatus !== 'active' && !isRealTrial) redirect('/subscribe')

  return (
    <div data-role={session.role} data-company={session.activeCompanyId}>
      <PrimaryNav role={session.role} />
      <main className={styles.main}>
        {children}
      </main>
      <MobileMenu role={session.role} />
    </div>
  )
}
