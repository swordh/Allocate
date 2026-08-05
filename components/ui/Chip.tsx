import type { ButtonHTMLAttributes } from 'react'
import styles from './Chip.module.css'

export type ChipSize = 'md' | 'sm' | 'cycle'

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
  size?: ChipSize
}

const SIZES: Record<ChipSize, string> = {
  md: styles.md,
  sm: styles.sm,
  cycle: styles.cycle,
}

/** Filter chips, role chips and any other single-select/toggle pill. */
export default function Chip({
  active = false,
  size = 'md',
  className,
  type = 'button',
  children,
  ...rest
}: ChipProps) {
  const classes = [
    styles.chip,
    SIZES[size],
    active ? styles.active : styles.inactive,
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button type={type} aria-pressed={active} className={classes} {...rest}>
      {children}
    </button>
  )
}
