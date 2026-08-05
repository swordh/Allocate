import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { getVerifiedSession } from '@/lib/dal'
import { getUserProfile } from '@/lib/queries/users'
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
  const subscription = companyData?.subscription
  const subStatus = subscription?.status
  const trialEnd = subscription?.trialEnd ?? null

  // No subscription object at all — the company never started checkout.
  if (!subscription) redirect('/subscribe')

  // A real Stripe trial has trialEnd set by the webhook on subscription.created.
  // The initial auto-trial (trialEnd=null) is not a real trial and stays blocked.
  const isRealTrial = subStatus === 'trialing' && trialEnd !== null
  const hasFullAccess = subStatus === 'active' || isRealTrial

  // past_due / canceled / incomplete may reach /settings/** (e.g. to update
  // their card) but nothing else under (app).
  const settingsOnlyStatuses = ['past_due', 'canceled', 'incomplete']
  const settingsOnly = settingsOnlyStatuses.includes(subStatus)

  if (!hasFullAccess) {
    if (settingsOnly) {
      const pathname = (await headers()).get('x-pathname') ?? ''
      if (!pathname.startsWith('/settings')) redirect('/subscribe')
    } else {
      redirect('/subscribe')
    }
  }

  const profile = await getUserProfile(session.uid)

  return (
    <div data-role={session.role} data-company={session.activeCompanyId}>
      <PrimaryNav role={session.role} />
      <main className={styles.main}>
        {children}
      </main>
      <MobileMenu role={session.role} name={profile?.name ?? ''} email={session.email} />
    </div>
  )
}
