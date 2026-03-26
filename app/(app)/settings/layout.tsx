import { redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'
import SettingsSecondaryNav from '@/components/nav/SettingsSecondaryNav'

/**
 * Settings layout — Server Component.
 * Admin-only. Redirects non-admins to /bookings.
 * Renders the secondary sub-nav (Company | Team | Subscription).
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await getVerifiedSession()

  if (session.role !== 'admin') {
    redirect('/bookings')
  }

  return (
    <>
      <SettingsSecondaryNav />
      {children}
    </>
  )
}
