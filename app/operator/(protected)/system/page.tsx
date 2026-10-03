import { getOperatorSession } from '@/lib/operator-dal'
import { getRegistrationFlags, type RegistrationFlags } from '@/lib/registrationFlags'
import ErrorBanner from '@/components/ui/ErrorBanner'
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
  // Unlike the customer pages, an unreadable flag must NOT be shown as "open"
  // here — the operator would be looking at a switch state that may be wrong.
  let flags: RegistrationFlags | null = null
  try {
    flags = await getRegistrationFlags()
  } catch (err) {
    console.error('[operator/system]', {
      action: 'flags_read_failed',
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return (
    <div className={styles.page}>
      <div className={styles.titleRow}>
        <h1 className={styles.title}>System</h1>
        <p className={styles.titleNote}>
          Applies to everyone using Allocate. Every change is logged with your name and reason.
        </p>
      </div>

      {flags ? (
        <div className={styles.grid}>
          <SystemSwitches flags={flags} />
        </div>
      ) : (
        <ErrorBanner tone="danger">
          Could not read the current switch state. Reload to try again — nothing has been changed.
        </ErrorBanner>
      )}
    </div>
  )
}
