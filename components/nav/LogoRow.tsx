import styles from './LogoRow.module.css'

/**
 * LogoRow — Server Component.
 * Static for Phase 2. Contextual right-side content added in Phase 3
 * when calendar views are connected.
 */
export default function LogoRow() {
  return (
    <div className={styles.wrapper}>
      <div className={styles.logoBlock}>
        <span className={styles.logo}>Allocate</span>
        <div className={styles.subRow}>
          <span className={styles.subLabel}>Gear Management System</span>
          {/* Contextual right-side content (week nav etc.) added in Phase 3 */}
        </div>
      </div>
    </div>
  )
}
