import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import Link from 'next/link'
import styles from './LegalLayout.module.css'

export interface LegalSectionMeta {
  id: string
  label: string
}

interface LegalLayoutProps {
  page: 'privacy' | 'terms'
  eyebrow: string
  title: string
  lede: string
  /**
   * Single source of truth for the sticky TOC links. Section numbering is
   * NOT taken from here — it is derived from the order of `children`
   * (each a `LegalSection`) so numbers are never hand-typed twice.
   */
  sections: LegalSectionMeta[]
  children: ReactNode
}

const OTHER_PAGE: Record<LegalLayoutProps['page'], { href: string; label: string }> = {
  privacy: { href: '/terms', label: 'Terms of Service' },
  terms: { href: '/privacy', label: 'Privacy Policy' },
}

export default function LegalLayout({ page, eyebrow, title, lede, sections, children }: LegalLayoutProps) {
  const other = OTHER_PAGE[page]

  // Inject the section number from position alone — callers never pass `n`.
  const numberedChildren = Children.map(children, (child, i) => {
    if (!isValidElement(child)) return child
    return cloneElement(child as ReactElement<{ n?: number }>, { n: i + 1 })
  })

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link href="/" className={styles.wordmark}>
            ALLOCATE
          </Link>
          <nav className={styles.nav}>
            <Link href="/terms" className={page === 'terms' ? styles.navLinkActive : styles.navLink}>
              Terms of Service
            </Link>
            <Link href="/privacy" className={page === 'privacy' ? styles.navLinkActive : styles.navLink}>
              Privacy Policy
            </Link>
          </nav>
        </div>
      </header>

      <div className={styles.main}>
        <div className={styles.grid}>
          <nav className={styles.toc} aria-label="Table of contents">
            <span className={styles.tocLabel}>Contents</span>
            <div className={styles.tocLinks}>
              {sections.map((section) => (
                <a key={section.id} href={`#${section.id}`} className={styles.tocLink}>
                  {section.label}
                </a>
              ))}
            </div>
          </nav>

          <article className={styles.article}>
            <div className={styles.titleBlock}>
              <span className={styles.eyebrow}>{eyebrow}</span>
              <h1 className={styles.title}>{title}</h1>
              <p className={styles.lede}>{lede}</p>
            </div>

            {numberedChildren}
          </article>

          <div className={styles.spacer} />
        </div>
      </div>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <p className={styles.copyright}>© 2026 Allocate. All rights reserved.</p>
          <div className={styles.footerLinks}>
            <Link href={other.href}>{other.label}</Link>
            <Link href="/">Back to Allocate</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}
