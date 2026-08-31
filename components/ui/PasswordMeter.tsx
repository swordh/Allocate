import styles from './PasswordMeter.module.css'

export type PasswordStrength = 'weak' | 'ok'

interface PasswordMeterProps {
  strength: PasswordStrength
  className?: string
}

/**
 * Three-segment strength indicator. Segment 3 is never lit in any authored
 * design state — there is no "strong" level, don't invent one.
 * The textual hint lives in `Field`'s `hint` prop, not here.
 */
export default function PasswordMeter({ strength, className }: PasswordMeterProps) {
  const segments =
    strength === 'weak' ? [styles.danger, '', ''] : [styles.accent, styles.accent, '']

  return (
    <span className={[styles.meter, className ?? ''].filter(Boolean).join(' ')} aria-hidden="true">
      {segments.map((tone, i) => (
        <span key={i} className={[styles.segment, tone].filter(Boolean).join(' ')} />
      ))}
    </span>
  )
}
