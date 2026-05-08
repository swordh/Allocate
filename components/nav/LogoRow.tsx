import styles from './LogoRow.module.css'

interface LogoRowProps {
  /** Optional content rendered in the right side of the sub-row.
   *  Pass week navigation, item counts, etc. from the page/layout.
   *  Must be a serializable React node (no event handlers from Server Components). */
  rightContent?: React.ReactNode
}

const ENV_LABELS: Record<string, string> = {
  dev:   'Dev',
  alpha: 'Alpha',
  beta:  'Beta',
}

export default function LogoRow({ rightContent }: LogoRowProps) {
  const env = process.env.NEXT_PUBLIC_APP_ENV
  const envLabel = env ? ENV_LABELS[env] : undefined

  return (
    <div className={styles.wrapper}>
      <div className={styles.logoBlock}>
        <div className={styles.logoLine}>
          <span className={styles.logo}>Allocate</span>
          {envLabel && (
            <span className={`${styles.envBadge} ${styles[`envBadge_${env}`]}`}>
              {envLabel}
            </span>
          )}
        </div>
        <div className={styles.subRow}>
          <span className={styles.subLabel}>Gear Management System</span>
          {rightContent && (
            <div className={styles.rightContent}>{rightContent}</div>
          )}
        </div>
      </div>
    </div>
  )
}
