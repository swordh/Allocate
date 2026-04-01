import { getVerifiedSession } from '@/lib/dal'
import PrimaryNav from '@/components/nav/PrimaryNav'
import { MobileBottomNav } from '@/components/nav/MobileBottomNav'
import styles from './app-layout.module.css'

/**
 * Authenticated layout — Server Component.
 * Verifies session on every render; redirects to /login if invalid.
 * PrimaryNav is a Client Component and handles active-link detection itself.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getVerifiedSession()

  return (
    <div data-role={session.role} data-company={session.activeCompanyId}>
      <PrimaryNav role={session.role} />
      <main className={styles.main}>
        {children}
      </main>
      <MobileBottomNav role={session.role} />
    </div>
  )
}
