import type { ReactNode } from 'react'
import styles from './LegalContact.module.css'

export interface LegalContactColumn {
  label: string
  value: ReactNode
}

interface LegalContactProps {
  columns: LegalContactColumn[]
}

/** Bordered contact card — one column for terms, email + entity for privacy. */
export default function LegalContact({ columns }: LegalContactProps) {
  return (
    <div className={styles.card}>
      {columns.map((col, i) => (
        <div key={i} className={styles.column}>
          <span className={styles.label}>{col.label}</span>
          <span className={styles.value}>{col.value}</span>
        </div>
      ))}
    </div>
  )
}
