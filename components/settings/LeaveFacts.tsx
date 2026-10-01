import styles from './LeaveFacts.module.css'

export interface LeaveFact {
  label: string
  value: string
  /** Colours the label — `danger` for the line about losing access. */
  tone?: 'danger' | 'accent'
}

interface LeaveFactsProps {
  facts: LeaveFact[]
  className?: string
}

/**
 * The bordered label/value table the leave-company screens share (issue
 * #352). Two columns on desktop, label stacked above value on mobile — the
 * breakpoint switch lives entirely in the CSS module.
 */
export default function LeaveFacts({ facts, className }: LeaveFactsProps) {
  return (
    <dl className={className ? `${styles.facts} ${className}` : styles.facts}>
      {facts.map((fact) => (
        <div key={fact.label} className={styles.row}>
          <dt className={`${styles.label} ${fact.tone ? styles[fact.tone] : ''}`}>{fact.label}</dt>
          <dd className={styles.value}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}
