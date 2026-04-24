import { redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import { adminDb } from '@/lib/firebase-admin'
import SubscribePage from './SubscribePage'

export default async function SubscribeRoute() {
  const session = await getVerifiedSession()
  const companyDoc = await adminDb.doc(`companies/${session.activeCompanyId}`).get()
  const subStatus = companyDoc.data()?.subscription?.status

  if (subStatus === 'active' || subStatus === 'trialing') {
    redirect('/settings/subscription')
  }

  return <SubscribePage />
}
