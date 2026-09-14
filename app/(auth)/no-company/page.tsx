import type { Metadata } from 'next'
import { getSessionWithoutCompany } from '@/lib/dal'
import { getUserProfile } from '@/lib/queries/users'
import NoCompanyView from '@/components/auth/NoCompanyView'

export const metadata: Metadata = {
  title: 'No company — Allocate',
}

/**
 * Landing page for a signed-in user with no active company (issue #252
 * step 5, PR F). `getVerifiedSession` (lib/dal.ts) redirects here — instead
 * of bouncing her to /login, which used to loop forever, since signing in
 * re-issues a valid session cookie that still carries no company claim.
 *
 * `getSessionWithoutCompany` bounces her straight to /bookings if it turns
 * out she DOES have a working company — this page has nothing to offer her
 * once that's true again.
 */
export default async function NoCompanyPage() {
  const session = await getSessionWithoutCompany()
  const profile = await getUserProfile(session.uid)

  return (
    <NoCompanyView
      name={profile?.name ?? ''}
      email={session.email}
      pendingDeletion={profile?.pendingDeletion ?? null}
    />
  )
}
