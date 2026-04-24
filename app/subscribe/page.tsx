import { redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { adminDb } from '@/lib/firebase-admin'
import SubscribePage from './SubscribePage'

export default async function SubscribeRoute() {
  const session = await getVerifiedSession()
  const companyDoc = await adminDb.doc(`companies/${session.activeCompanyId}`).get()
  const companyData = companyDoc.data()
  const subStatus = companyData?.subscription?.status
  const trialEnd = companyData?.subscription?.trialEnd ?? null

  // Mirror the layout gate: redirect away only if they have an active subscription or a real Stripe trial
  const isRealTrial = subStatus === 'trialing' && trialEnd !== null
  if (subStatus === 'active' || isRealTrial) {
    redirect('/settings/subscription')
  }

  return <SubscribePage />
}
