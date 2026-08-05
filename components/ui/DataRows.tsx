import type { CSSProperties, ReactNode } from 'react'
import styles from './DataRows.module.css'

export type DataRowsVariant = 'inline' | 'boxed'

export interface DataRow {
  term: string
  value: ReactNode
}

interface DataRowsProps {
  rows: DataRow[]
  variant?: DataRowsVariant
  /** `inline` only — overrides the term column width (design uses 110px and 130px per screen). */
  termWidth?: number
  className?: string
}

/**
 * Label/value grid in two skins: `inline` (auth links, revoked invitations)
 * and `boxed` (legal data tables). Values accept ReactNode so callers can
 * keep inline links inside a cell.
 */
export default function DataRows({
  rows,
  variant = 'inline',
  termWidth,
  className,
}: DataRowsProps) {
  const classes = [
    styles[variant],
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  const style =
    variant === 'inline' && termWidth
      ? ({ '--data-term-width': `${termWidth}px` } as CSSProperties)
      : undefined

  return (
    <div className={classes} style={style}>
      {rows.map((row, i) => (
        <div className={styles.row} key={i}>
          <span className={styles.term}>{row.term}</span>
          <span className={styles.value}>{row.value}</span>
        </div>
      ))}
    </div>
  )
}
