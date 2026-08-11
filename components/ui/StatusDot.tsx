import styles from './StatusDot.module.css'

interface StatusDotProps {
  /** 5px on notice banners and month bars, 6px on booking blocks, 7px on list rows. */
  size?: 5 | 6 | 7
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
