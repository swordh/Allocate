import type { ReactNode } from 'react'
import styles from './Field.module.css'

interface FieldProps {
  label: string
  htmlFor?: string
  required?: boolean
  /** Rendered after the label, e.g. "(optional)". */
  optionalHint?: string
  /** Guidance below the control. Replaced by `error` when that is set. */
  helper?: string
  error?: string
  size?: 'md' | 'sm'
  children: ReactNode
  className?: string
}

/** Label + control + helper/error. The control itself is passed as children. */
export default function Field({
  label,
  htmlFor,
  required = false,
  optionalHint,
  helper,
  error,
  size = 'md',
  children,
  className,
}: FieldProps) {
  const classes = [styles.field, size === 'sm' ? styles.sm : styles.md, className ?? '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes}>
      <label className={styles.label} htmlFor={htmlFor}>
        {label}
        {required && (
          <span className={styles.required} aria-hidden="true">
            *
          </span>
        )}
        {optionalHint && <span className={styles.optional}>{optionalHint}</span>}
      </label>
      {children}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : (
        helper && <p className={styles.helper}>{helper}</p>
      )}
    </div>
  )
}
