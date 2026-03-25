import { getVerifiedSession } from '@/lib/dal'

/**
 * Authenticated layout — Server Component.
 * Verifies session on every render; redirects to /login if invalid.
 * Passes serializable role/companyId down as props to child layouts and Client Components.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // This call redirects to /login if the session is missing or invalid.
  const session = await getVerifiedSession()

  return (
    <div data-role={session.role} data-company={session.activeCompanyId}>
      {/* Primary nav and company context will be added in Phase 2 */}
      {children}
    </div>
  )
}
