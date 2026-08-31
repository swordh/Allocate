import type { ReactNode } from 'react'
import styles from './Field.module.css'

export type FieldHintTone = 'accent' | 'danger' | 'neutral'

interface FieldHint {
  tone: FieldHintTone
  text: string
}

interface FieldProps {
  label: string
  htmlFor?: string
  required?: boolean
  /** Rendered after the label, e.g. "(optional)". */
  optionalHint?: string
  /** Right-aligned slot in the label row, e.g. a "FORGOT?" link. */
  labelAction?: ReactNode
  /** Guidance below the control. Replaced by `error` when that is set. */
  helper?: string
  error?: string
  /** Tinted, dotted guidance below the control — live validation, password strength. */
  hint?: FieldHint
  size?: 'md' | 'sm'
  children: ReactNode
  className?: string
}

const HINT_TONES: Record<FieldHintTone, string> = {
  accent: styles.hintAccent,
  danger: styles.hintDanger,
  neutral: styles.hintNeutral,
}

/** Label + control + helper/error. The control itself is passed as children. */
export default function Field({
  label,
  htmlFor,
  required = false,
  optionalHint,
  labelAction,
  helper,
  error,
  hint,
  size = 'md',
  children,
  className,
}: FieldProps) {
  const classes = [
    styles.field,
    size === 'sm' ? styles.sm : styles.md,
    error ? styles.hasError : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes}>
      <div className={styles.labelRow}>
        <label className={styles.label} htmlFor={htmlFor}>
          {label}
          {required && (
            <span className={styles.required} aria-hidden="true">
              *
            </span>
          )}
          {optionalHint && <span className={styles.optional}>{optionalHint}</span>}
        </label>
        {labelAction && <span className={styles.labelAction}>{labelAction}</span>}
      </div>
      {children}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : helper ? (
        <p className={styles.helper}>{helper}</p>
      ) : (
        hint && (
          <span className={[styles.hint, HINT_TONES[hint.tone]].join(' ')}>
            {hint.tone !== 'neutral' && <span className={styles.hintDot} aria-hidden="true" />}
            {hint.text}
          </span>
        )
      )}
    </div>
  )
}
