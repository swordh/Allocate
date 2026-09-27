import { redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'

/**
 * /settings → redirect to a default tab.
 *
 * Issue #350 (GDPR): this used to redirect unconditionally to
 * /settings/company, which is admin-only and NOT always-available — a
 * crew member on a planless company hitting bare /settings would pass
 * `evaluateAppAccess`'s pass-through rule (lib/subscriptionAccess.ts) only to
 * be bounced straight back out by /settings/company's own role/plan checks.
 * Redirecting by role instead means the pass-through always lands somewhere
 * that route is actually allowed to render: admin still gets Company
 * (unchanged default), everyone else gets Account, which is always
 * reachable for every role regardless of plan.
 */
export default async function SettingsPage() {
  const session = await getVerifiedSession()
  redirect(session.role === 'admin' ? '/settings/company' : '/settings/account')
}
