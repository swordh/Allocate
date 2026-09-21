import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { getVerifiedSession, getCompanyDoc } from '@/lib/dal'
import { getUserProfile } from '@/lib/queries/users'
import { listUserCompanies } from '@/lib/queries/companies'
import { evaluateAppAccess, hasFullAccess } from '@/lib/subscriptionAccess'
import PrimaryNav from '@/components/nav/PrimaryNav'
import { MobileMenu } from '@/components/nav/MobileMenu'
import CompanyDeletionBanner from '@/components/company/CompanyDeletionBanner'
import NoPlanBanner from '@/components/subscription/NoPlanBanner'
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

  // Issue #350 (GDPR) — see lib/subscriptionAccess.ts for the full rationale.
  // `headers()` is now read unconditionally (not just on the settings-only
  // branch the old guard had) because evaluateAppAccess needs the pathname
  // for every request, not only ones from a scoped status.
  const pathname = (await headers()).get('x-pathname')
  const access = evaluateAppAccess({ pathname, role: session.role, subStatus, trialEnd })
  if (!access.allowed) redirect(access.redirectTo)
  const fullAccess = hasFullAccess(subStatus, trialEnd)

  const profile = await getUserProfile(session.uid)

  // Company switcher (issue #352) — the membership list is the same for
  // every render in this request, so one fetch here serves both PrimaryNav
  // (desktop) and MobileMenu (mobile); companyData is already loaded above.
  const companies = await listUserCompanies(session.uid)
  const companyName = companyData?.name ?? ''

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
      <PrimaryNav
        role={session.role}
        name={profile?.name ?? ''}
        email={session.email}
        activeCompanyId={session.activeCompanyId}
      />
      <main className={styles.main}>
        <CompanyDeletionBanner
          deletion={deletionForBanner}
          role={session.role}
          timezone={timezone}
          className={styles.deletionBanner}
        />
        <NoPlanBanner
          hasFullAccess={fullAccess}
          role={session.role}
          className={styles.deletionBanner}
        />
        {children}
      </main>
      <MobileMenu
        role={session.role}
        name={profile?.name ?? ''}
        email={session.email}
        companyName={companyName}
        activeCompanyId={session.activeCompanyId}
        companies={companies}
        hasFullAccess={fullAccess}
      />
    </div>
  )
}
