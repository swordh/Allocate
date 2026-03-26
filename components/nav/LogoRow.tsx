import styles from './LogoRow.module.css'

interface LogoRowProps {
  /** Optional content rendered in the right side of the sub-row.
   *  Pass week navigation, item counts, etc. from the page/layout.
   *  Must be a serializable React node (no event handlers from Server Components). */
  rightContent?: React.ReactNode
}

/**
 * LogoRow — Server Component.
 * Renders the large "Allocate" wordmark and an optional contextual
 * right-side element (week nav, item counts, etc.).
 */
export default function LogoRow({ rightContent }: LogoRowProps) {
  return (
    <div className={styles.wrapper}>
      <div className={styles.logoBlock}>
        <span className={styles.logo}>Allocate</span>
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
