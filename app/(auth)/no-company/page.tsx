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
      /*
       * Only the date crosses the RSC boundary — never the whole
       * `pendingDeletion` object. A React Server Component serialises a prop
       * in full regardless of which parts the client component reads, so
       * passing the object would put `requestId` — the document id in
       * `companyDeletions` — into the page's network payload. It grants no
       * access (firestore.rules denies every client read of that collection,
       * and says in so many words that it must never be readable to
       * members), but the point of that rule is that the ledger is not
       * member-visible; leaking its primary key into the browser is the
       * first half of contradicting it for free.
       *
       * The two props are separate on purpose: a schedule whose date is
       * unreadable (see `toIsoStringOrEmpty`, lib/queries/users.ts) must
       * still tell her she is scheduled — a single nullable date prop would
       * collapse that case into "nothing is happening", which is the one
       * thing this screen must never say to a stranded user.
       */
      deletionScheduled={profile?.pendingDeletion !== undefined}
      deletionScheduledFor={profile?.pendingDeletion?.scheduledFor || null}
    />
  )
}
