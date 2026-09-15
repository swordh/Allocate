import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { getVerifiedSession, getCompanyDoc } from '@/lib/dal'
import { getUserProfile } from '@/lib/queries/users'
import PrimaryNav from '@/components/nav/PrimaryNav'
import { MobileMenu } from '@/components/nav/MobileMenu'
import CompanyDeletionBanner from '@/components/company/CompanyDeletionBanner'
import type { CompanyDeletionBannerData } from '@/lib/companyDeletionBanner'
import type { CompanyDeletionState } from '@/types'
import styles from './app-layout.module.css'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getVerifiedSession()

  // getVerifiedSession() already redirected to /no-company if this document
  // didn't exist (lib/dal.ts) — no need to re-check existence here. Reading
  // it via the same `getCompanyDoc` it used means React's cache() dedupes
  // the two calls into one Firestore read for this request rather than two.
  const companyDoc = await getCompanyDoc(session.activeCompanyId)
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

  // Company-deletion banner (issue #252 step 6, PR 3) — visible to every
  // member, not just admins; see CompanyDeletionBanner's own docblock for
  // why. `companyData` is raw Firestore data, not the `docToCompany`-mapped
  // `Company` (see the comment above), so `deletion.scheduledFor` here is
  // still a Firestore `Timestamp`, not the ISO string `types/company.ts`
  // promises on the mapped type. Normalize it to a plain, minimal object
  // before it crosses to a component — sending a `Timestamp` across the
  // Server/Client boundary breaks RSC serialization, and the banner only
  // ever needs `state` and `scheduledFor`, not the rest of `deletion`.
  const rawDeletion = companyData?.deletion as
    | { state?: CompanyDeletionState; scheduledFor?: { toDate: () => Date } | string }
    | undefined
  const rawScheduledFor = rawDeletion?.scheduledFor
  const deletionForBanner: CompanyDeletionBannerData | null = rawDeletion?.state
    ? {
        state: rawDeletion.state,
        scheduledFor:
          typeof rawScheduledFor === 'string' ? rawScheduledFor : (rawScheduledFor?.toDate().toISOString() ?? ''),
      }
    : null
  const timezone = companyData?.preferences?.timezone ?? 'UTC'

  return (
    <div data-role={session.role} data-company={session.activeCompanyId}>
      <PrimaryNav role={session.role} />
      <main className={styles.main}>
        <CompanyDeletionBanner
          deletion={deletionForBanner}
          role={session.role}
          timezone={timezone}
          className={styles.deletionBanner}
        />
        {children}
      </main>
      <MobileMenu role={session.role} name={profile?.name ?? ''} email={session.email} />
    </div>
  )
}
