import styles from './StatusDot.module.css'

interface StatusDotProps {
  /** 5px on notice banners, 6px on booking blocks. */
  size?: 5 | 6
  /** Defaults to currentColor so the dot picks up its context's colour. */
  color?: string
  className?: string
}

export default function StatusDot({ size = 5, color, className }: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      className={className ? `${styles.dot} ${className}` : styles.dot}
      style={{ width: size, height: size, background: color }}
    />
  )
}
