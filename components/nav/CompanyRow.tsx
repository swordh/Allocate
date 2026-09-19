import styles from './CompanyRow.module.css'

interface CompanyRowProps {
  name: string
  active: boolean
  onClick?: () => void
  /** `menu` — desktop user menu row (no full border, thin left accent).
   *  `list` — mobile SWITCH COMPANY sub-view row (full hairline border, thick left accent). */
  variant: 'menu' | 'list'
  role?: 'menuitem'
}

/**
 * One company row shared by the desktop `CompanyMenu` and the mobile
 * `MobileMenu` company sub-view — both need the same active-marker rule
 * (accent left border + tint + "ACTIVE" tag vs. plain text), just with
 * slightly different chrome per the two design handoffs.
 */
export default function CompanyRow({ name, active, onClick, variant, role }: CompanyRowProps) {
  const classes = [styles.row, styles[variant], active ? styles.active : ''].filter(Boolean).join(' ')

  return (
    <button type="button" className={classes} onClick={onClick} role={role} disabled={!onClick}>
      <span className={styles.name}>{name}</span>
      {active && <span className={styles.tag}>Active</span>}
    </button>
  )
}
