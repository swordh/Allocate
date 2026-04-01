import styles from './auth-layout.module.css'

// Minimal shell for unauthenticated routes — auth header/footer, no nav, no auth check.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.authShell}>
      <header className={styles.authHeader}>
        <span className={styles.wordmark}>ALLOCATE</span>
      </header>
      <main className={styles.authMain}>{children}</main>
      <footer className={styles.authFooter}>
        <p>© 2024 ALLOCATE. ALL RIGHTS RESERVED.</p>
        <div className={styles.authFooterLinks}>
          <a href="#">LEGAL</a>
          <a href="#">PRIVACY</a>
          <a href="#">TERMS</a>
        </div>
      </footer>
    </div>
  )
}
