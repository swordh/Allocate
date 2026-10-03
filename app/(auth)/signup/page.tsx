import { Suspense } from 'react'
import SignupForm from '@/components/auth/SignupForm'
import RegistrationPaused from '@/components/auth/RegistrationPaused'
import { getRegistrationFlagsOrOpen } from '@/lib/registrationFlags'

// Same shape SignupForm accepts for an invite deep link: /invite/<token>.
const INVITE_REDIRECT = /^\/invite\/[a-zA-Z0-9]{1,40}$/

/**
 * Server Component shell — SignupForm handles all interactive Firebase Auth logic.
 * Suspense is required because SignupForm reads useSearchParams() at render time.
 *
 * Reads the operator registration switches (lib/registrationFlags.ts):
 *   - accountsBlocked: renders the "New accounts are paused" screen instead of
 *     the form, UNLESS the visitor is on the invite path (`?mode=invite`, or a
 *     `redirect` that is an /invite/<token> link) — invitations keep working.
 *     This is UI-only by decision: the Auth API can still be called directly.
 *   - companiesBlocked: passed down; the form's "New company" tab shows the
 *     paused notice. Company creation is also refused server-side in
 *     `setupNewCompany`.
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; redirect?: string }>
}) {
  const [flags, params] = await Promise.all([getRegistrationFlagsOrOpen(), searchParams])

  const onInvitePath =
    params.mode === 'invite' || (typeof params.redirect === 'string' && INVITE_REDIRECT.test(params.redirect))

  if (flags.accountsBlocked && !onInvitePath) {
    return (
      <RegistrationPaused
        variant="accounts"
        primary={{ label: 'I have an invite', href: '/signup?mode=invite' }}
        secondary={{ label: 'Sign in', href: '/login' }}
      />
    )
  }

  return (
    <Suspense>
      <SignupForm companiesBlocked={flags.companiesBlocked} accountsBlocked={flags.accountsBlocked} />
    </Suspense>
  )
}
