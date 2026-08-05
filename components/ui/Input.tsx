import type { InputHTMLAttributes } from 'react'
import styles from './Input.module.css'

export type InputSize = 'lg' | 'md' | 'sm'

/** `size` is taken by the DOM attribute, hence `inputSize`. */
interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  inputSize?: InputSize
  invalid?: boolean
}

const SIZES: Record<InputSize, string> = {
  lg: styles.lg,
  md: styles.md,
  sm: styles.sm,
}

export default function Input({
  inputSize = 'md',
  invalid = false,
  className,
  ...rest
}: InputProps) {
  const classes = [styles.input, SIZES[inputSize], invalid ? styles.invalid : '', className ?? '']
    .filter(Boolean)
    .join(' ')

  return <input className={classes} aria-invalid={invalid || undefined} {...rest} />
}
