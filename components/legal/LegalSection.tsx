import type { ReactNode } from 'react'
import styles from './LegalSection.module.css'

interface LegalSectionProps {
  id: string
  /** Injected by `LegalLayout` from child position — do not pass this by hand. */
  n?: number
  title: string
  children: ReactNode
}

export default function LegalSection({ id, n, title, children }: LegalSectionProps) {
  return (
    <section id={id} className={styles.section}>
      <h2 className={styles.heading}>
        {n != null ? `${n}. ` : ''}
        {title}
      </h2>
      <div className={styles.body}>{children}</div>
    </section>
  )
}
