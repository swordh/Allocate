import type { InputHTMLAttributes } from 'react'
import styles from './Input.module.css'

export type InputSize = 'lg' | 'md' | 'sm'

/** `size` is taken by the DOM attribute, hence `inputSize`. */
interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  inputSize?: InputSize
  invalid?: boolean
  /** Accent-tinted border for an in-flight async check (e.g. invite code lookup). */
  busy?: boolean
  /** Sunken, non-interactive appearance for a value the user can't edit (e.g. email locked to an invite). */
  locked?: boolean
  /** Monospace, wide-tracking font for tokens/codes. */
  mono?: boolean
}

const SIZES: Record<InputSize, string> = {
  lg: styles.lg,
  md: styles.md,
  sm: styles.sm,
}

export default function Input({
  inputSize = 'md',
  invalid = false,
  busy = false,
  locked = false,
  mono = false,
  className,
  disabled,
  ...rest
}: InputProps) {
  const classes = [
    styles.input,
    SIZES[inputSize],
    invalid ? styles.invalid : '',
    busy ? styles.busy : '',
    locked ? styles.locked : '',
    mono ? styles.mono : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <input
      className={classes}
      aria-invalid={invalid || undefined}
      disabled={disabled || locked}
      {...rest}
    />
  )
}
