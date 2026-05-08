import Link from 'next/link'
import styles from './auth-layout.module.css'

const ENV_LABELS: Record<string, string> = {
  dev:   'Dev',
  alpha: 'Alpha',
  beta:  'Beta',
}

// Minimal shell for unauthenticated routes — auth header/footer, no nav, no auth check.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const env = process.env.NEXT_PUBLIC_APP_ENV
  const envLabel = env ? ENV_LABELS[env] : undefined

  return (
    <div className={styles.authShell}>
      <header className={styles.authHeader}>
        <span className={styles.wordmark}>ALLOCATE</span>
        {envLabel && (
          <span className={`${styles.envBadge} ${styles[`envBadge_${env}`]}`}>
            {envLabel}
          </span>
        )}
      </header>
      <main className={styles.authMain}>{children}</main>
      <footer className={styles.authFooter}>
        <p>© 2026 ALLOCATE. ALL RIGHTS RESERVED.</p>
        <div className={styles.authFooterLinks}>
          <Link href="/privacy">PRIVACY</Link>
          <Link href="/terms">TERMS</Link>
        </div>
      </footer>
    </div>
  )
}
