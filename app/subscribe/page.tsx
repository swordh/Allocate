import { redirect } from 'next/navigation'
import { getVerifiedSession, getCompanyDoc } from '@/lib/dal'
import SubscribePage from './SubscribePage'

export default async function SubscribeRoute() {
  const session = await getVerifiedSession()
  // Same document getVerifiedSession() just read to confirm it exists —
  // getCompanyDoc's React.cache() dedupes this into the same Firestore read.
  const companyDoc = await getCompanyDoc(session.activeCompanyId)
  const companyData = companyDoc.data()
  const subStatus = companyData?.subscription?.status
  const trialEnd = companyData?.subscription?.trialEnd ?? null

  // Mirror the layout gate: redirect away only if they have an active subscription or a real Stripe trial
  const isRealTrial = subStatus === 'trialing' && trialEnd !== null
  if (subStatus === 'active' || isRealTrial) {
    redirect('/settings/subscription')
  }

  return <SubscribePage companyName={companyData?.name ?? ''} />
}
