import { headers } from 'next/headers'
import { getVerifiedSession } from '@/lib/dal'
import PrimaryNav from '@/components/nav/PrimaryNav'
import { MobileBottomNav } from '@/components/nav/MobileBottomNav'
import styles from './app-layout.module.css'

/**
 * Authenticated layout — Server Component.
 * Verifies session on every render; redirects to /login if invalid.
 * Renders PrimaryNav, passing serializable role and activePath.
 * LogoRow removed; each section now uses PageHeader.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getVerifiedSession()

  // Read the current pathname from request headers so we can pass it as a
  // serializable prop to the Server Component PrimaryNav (no usePathname needed).
  const headersList = await headers()
  const activePath = headersList.get('x-pathname') ?? '/'

  return (
    <div data-role={session.role} data-company={session.activeCompanyId}>
      <PrimaryNav role={session.role} activePath={activePath} />
      <main className={styles.main}>
        {children}
      </main>
      <MobileBottomNav role={session.role} />
    </div>
  )
}
