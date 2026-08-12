import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from 'react'
import Link from 'next/link'
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

interface ButtonOwnProps {
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
  /** Renders a leading dot, tints the background and forces `disabled`/`aria-busy`. */
  loading?: boolean
}

interface ButtonAsButtonProps extends ButtonOwnProps, ButtonHTMLAttributes<HTMLButtonElement> {
  href?: undefined
}

interface ButtonAsLinkProps extends ButtonOwnProps, AnchorHTMLAttributes<HTMLAnchorElement> {
  /** Renders a Next `<Link>` with identical styling instead of a `<button>`. */
  href: string
}

type ButtonProps = ButtonAsButtonProps | ButtonAsLinkProps

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

  if ('href' in rest && rest.href !== undefined) {
    const { href, ...anchorRest } = rest as ButtonAsLinkProps
    return (
      <Link href={href} className={classes} {...anchorRest}>
        {loading && <span className={styles.loadingDot} aria-hidden="true" />}
        {children}
      </Link>
    )
  }

  const { type = 'button', disabled, ...buttonRest } = rest as ButtonAsButtonProps
  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...buttonRest}
    >
      {loading && <span className={styles.loadingDot} aria-hidden="true" />}
      {children}
    </button>
  )
}
