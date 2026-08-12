import type { ButtonHTMLAttributes, HTMLAttributes } from 'react'
import styles from './Chip.module.css'

export type ChipSize = 'md' | 'sm' | 'cycle' | 'tag'
export type ChipTone = 'neutral' | 'accent' | 'danger'
export type ChipVariant = 'default' | 'solid'

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
  size?: ChipSize
  tone?: ChipTone
  /**
   * 'solid' renders the active state as white bg / black text instead of the
   * default dark-fill active look — the /subscribe screen's cycle toggle
   * (screen 18) and how chips look on mobile throughout. Inactive state is
   * unchanged.
   */
  variant?: ChipVariant
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
  variant = 'default',
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
    variant === 'solid' ? styles.solid : '',
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
