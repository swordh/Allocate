import styles from './PageHeader.module.css'

interface PageHeaderProps {
  title: string
  actions?: React.ReactNode
  nav?: React.ReactNode
  /** Optional line rendered under the title (e.g. "NORDFILM AB · STARTER PLAN · 6 MEMBERS"). */
  meta?: React.ReactNode
  /**
   * 'default' keeps the existing large clamp() heading used by routes not
   * yet redesigned (bookings, equipment). 'compact' is the settings-shell
   * size from the design (34px / 27px mobile) — opt in per caller so this
   * shared primitive stays non-breaking for callers that haven't been
   * restyled yet.
   */
  size?: 'default' | 'compact'
}

export function PageHeader({ title, actions, nav, meta, size = 'default' }: PageHeaderProps) {
  const titleClasses = size === 'compact' ? `${styles.title} ${styles.titleCompact}` : styles.title

  return (
    <header className={`${styles.header} ${nav ? styles.headerWithNav : ''}`}>
      <div className={styles.top}>
        <div>
          <h1 className={titleClasses}>{title}</h1>
          {meta && <div className={styles.meta}>{meta}</div>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
      {nav ?? <div className={styles.rule} />}
    </header>
  )
}
