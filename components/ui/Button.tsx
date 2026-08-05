import type { ButtonHTMLAttributes } from 'react'
import styles from './Button.module.css'

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'secondary-alt'
  | 'ghost'
  | 'danger'
  | 'danger-solid'

export type ButtonSize = 'lg' | 'md' | 'sm' | 'xs'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: styles.primary,
  secondary: styles.secondary,
  'secondary-alt': styles.secondaryAlt,
  ghost: styles.ghost,
  danger: styles.danger,
  'danger-solid': styles.dangerSolid,
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
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    styles.button,
    VARIANTS[variant],
    SIZES[size],
    fullWidth ? styles.fullWidth : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  )
}
