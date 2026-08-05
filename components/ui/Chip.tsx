import type { ButtonHTMLAttributes, HTMLAttributes } from 'react'
import styles from './Chip.module.css'

export type ChipSize = 'md' | 'sm' | 'cycle' | 'tag'
export type ChipTone = 'neutral' | 'accent' | 'danger'

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
  size?: ChipSize
  tone?: ChipTone
  /** Set false to render a non-interactive `<span>` — a status/metadata pill, not a toggle. */
  interactive?: boolean
}

const SIZES: Record<ChipSize, string> = {
  md: styles.md,
  sm: styles.sm,
  cycle: styles.cycle,
  tag: styles.tag,
}

const TONES: Record<ChipTone, string> = {
  neutral: '',
  accent: styles.toneAccent,
  danger: styles.toneDanger,
}

/** Filter chips, role chips and any other single-select/toggle pill. */
export default function Chip({
  active = false,
  size = 'md',
  tone = 'neutral',
  interactive = true,
  className,
  type = 'button',
  children,
  ...rest
}: ChipProps) {
  const classes = [
    styles.chip,
    SIZES[size],
    active ? styles.active : styles.inactive,
    TONES[tone],
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  if (!interactive) {
    const spanProps = rest as HTMLAttributes<HTMLSpanElement>
    return (
      <span className={classes} {...spanProps}>
        {children}
      </span>
    )
  }

  return (
    <button type={type} aria-pressed={active} className={classes} {...rest}>
      {children}
    </button>
  )
}
