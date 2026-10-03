import { getOperatorSession } from '@/lib/operator-dal'
import { getRegistrationFlags } from '@/lib/registrationFlags'
import SystemSwitches from './SystemSwitches'
import styles from './system.module.css'

export const metadata = { title: 'System — Allocate Operator' }

/**
 * Operator → System: site-wide settings. Today that is the two registration
 * kill switches (design_handoff_system_controls). The EMAIL · RESEND quota
 * column of the design is tracked as its own issue and is not built here, so
 * the grid's right column is intentionally absent.
 */
export default async function SystemPage() {
  await getOperatorSession()
  const flags = await getRegistrationFlags()

  return (
    <div className={styles.page}>
      <div className={styles.titleRow}>
        <h1 className={styles.title}>System</h1>
        <p className={styles.titleNote}>
          Applies to everyone using Allocate. Every change is logged with your name and reason.
        </p>
      </div>

      <div className={styles.grid}>
        <SystemSwitches flags={flags} />
      </div>
    </div>
  )
}
