import type { SelectHTMLAttributes } from 'react'
import styles from './Select.module.css'

export type SelectSize = 'lg' | 'md' | 'sm'

/** `size` is taken by the DOM attribute, hence `selectSize`. */
interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  selectSize?: SelectSize
  invalid?: boolean
}

const SIZES: Record<SelectSize, string> = {
  lg: styles.lg,
  md: styles.md,
  sm: styles.sm,
}

/** `<select>` skinned to match `Input` — same sizes, border and background. */
export default function Select({
  selectSize = 'md',
  invalid = false,
  className,
  children,
  ...rest
}: SelectProps) {
  const classes = [styles.select, SIZES[selectSize], invalid ? styles.invalid : '', className ?? '']
    .filter(Boolean)
    .join(' ')

  return (
    <select className={classes} aria-invalid={invalid || undefined} {...rest}>
      {children}
    </select>
  )
}
