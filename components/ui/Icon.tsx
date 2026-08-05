import { ICON_PATHS, type IconName } from './icon-paths'
import styles from './Icon.module.css'

export type { IconName }

interface IconProps {
  name: IconName
  /** Rendered box in px. Defaults to the design's 18px. */
  size?: number
  strokeWidth?: number
  className?: string
  /** Supply only when the icon carries meaning on its own. Otherwise it is hidden from assistive tech. */
  'aria-label'?: string
}

/**
 * Inline stroke icon. Replaces the Material Symbols icon font.
 *
 * Colour is never set on the SVG itself — it inherits via `currentColor`, so
 * the surrounding context decides. The default (--text-tertiary) lives in
 * Icon.module.css and any ancestor `color:` overrides it.
 */
export default function Icon({
  name,
  size = 18,
  strokeWidth = 1.8,
  className,
  'aria-label': ariaLabel,
}: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `${styles.icon} ${className}` : styles.icon}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      focusable="false"
    >
      {ICON_PATHS[name]}
    </svg>
  )
}
