import type { ButtonHTMLAttributes } from 'react'
import styles from './Button.module.css'

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'secondary-alt'
  | 'ghost'
  | 'danger'
  | 'danger-solid'
  | 'quiet'

export type ButtonSize = 'lg' | 'md' | 'sm' | 'xs'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
  /** Renders a leading dot, tints the background and forces `disabled`/`aria-busy`. */
  loading?: boolean
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: styles.primary,
  secondary: styles.secondary,
  'secondary-alt': styles.secondaryAlt,
  ghost: styles.ghost,
  danger: styles.danger,
  'danger-solid': styles.dangerSolid,
  quiet: styles.quiet,
}

const SIZES: Record<ButtonSize, string> = {
  lg: styles.lg,
  md: styles.md,
  sm: styles.sm,
  xs: styles.xs,
}

export default function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  loading = false,
  className,
  type = 'button',
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    styles.button,
    VARIANTS[variant],
    SIZES[size],
    fullWidth ? styles.fullWidth : '',
    loading ? styles.loading : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className={styles.loadingDot} aria-hidden="true" />}
      {children}
    </button>
  )
}
