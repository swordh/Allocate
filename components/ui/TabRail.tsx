import Link from 'next/link'
import styles from './TabRail.module.css'

export interface Tab {
  id: string
  label: string
  /** When set the tab renders as a link (route-backed tabs); otherwise as a button. */
  href?: string
}

interface TabRailProps {
  tabs: readonly Tab[]
  activeId: string
  /** Required for button-backed tabs; ignored when tabs carry href. */
  onSelect?: (id: string) => void
  ariaLabel: string
  className?: string
}

/** Underlined tab row. Route-backed when tabs carry href, local state otherwise. */
export default function TabRail({
  tabs,
  activeId,
  onSelect,
  ariaLabel,
  className,
}: TabRailProps) {
  return (
    <nav
      aria-label={ariaLabel}
      className={className ? `${styles.rail} ${className}` : styles.rail}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId
        const classes = `${styles.tab} ${active ? styles.active : ''}`

        return tab.href ? (
          <Link
            key={tab.id}
            href={tab.href}
            className={classes}
            aria-current={active ? 'page' : undefined}
          >
            {tab.label}
          </Link>
        ) : (
          <button
            key={tab.id}
            type="button"
            className={classes}
            aria-current={active ? 'true' : undefined}
            onClick={() => onSelect?.(tab.id)}
          >
            {tab.label}
          </button>
        )
      })}
    </nav>
  )
}
