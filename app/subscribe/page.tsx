import { redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { adminDb } from '@/lib/firebase-admin'
import SubscribePage from './SubscribePage'

export default async function SubscribeRoute() {
  const session = await getVerifiedSession()
  const companyDoc = await adminDb.doc(`companies/${session.activeCompanyId}`).get()
  const companyData = companyDoc.data()
  const subStatus = companyData?.subscription?.status
  const stripeCustomerId = companyData?.stripeCustomerId ?? ''

  // Only redirect to settings if they have a real Stripe subscription
  if ((subStatus === 'active' || subStatus === 'trialing') && stripeCustomerId) {
    redirect('/settings/subscription')
  }

  return <SubscribePage />
}
