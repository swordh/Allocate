import { redirect } from 'next/navigation'
import { getVerifiedSession, getCompanyDoc } from '@/lib/dal'
import { hasFullAccess } from '@/lib/subscriptionAccess'
import SubscribePage from './SubscribePage'
import NoPlanNotice from './NoPlanNotice'

/**
 * Issue #350 (GDPR) — role split. `evaluateAppAccess` (lib/subscriptionAccess.ts)
 * already keeps non-admins from being redirected HERE by the `(app)` layout
 * gate, but `/subscribe` lives outside `(app)` and has no route-group-level
 * role check of its own — a crew member can still type the URL
 * directly. This split is defense in depth, not the primary control: a
 * non-admin gets `NoPlanNotice` (no plan grid, no button that can produce
 * `actions/subscription.ts`'s "Only an administrator can change the plan"
 * error), an admin gets the real `SubscribePage`. See `NoPlanNotice`'s own
 * docblock for why it still renders `AccountRightsLink` — this is the page
 * that makes `app/privacy/page.tsx`'s "Account Settings" promise true for a
 * member who has no plan to pick.
 */
export default async function SubscribeRoute() {
  const session = await getVerifiedSession()
  // Same document getVerifiedSession() just read to confirm it exists —
  // getCompanyDoc's React.cache() dedupes this into the same Firestore read.
  const companyDoc = await getCompanyDoc(session.activeCompanyId)
  const companyData = companyDoc.data()
  const subStatus = companyData?.subscription?.status
  const trialEnd = companyData?.subscription?.trialEnd ?? null

  // Mirror the layout gate: redirect away only if they have an active subscription or a real Stripe trial
  if (hasFullAccess(subStatus, trialEnd)) {
    redirect('/settings/subscription')
  }

  if (session.role !== 'admin') {
    return <NoPlanNotice />
  }

  return <SubscribePage companyName={companyData?.name ?? ''} />
}
