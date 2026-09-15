import Chip from '@/components/ui/Chip'
import { formatDateFullInZone } from '@/lib/dates'
import { isStuckDeletion, nowMs, timeRemaining } from '@/lib/operatorDeletionView'
import type { CompanyDeletionRow } from '@/types/operator'
import DeletionHistoryList from './DeletionHistoryList'
import styles from './deletion.module.css'

const ZONE = 'UTC' // see DeletionHistoryList's docblock for why UTC, not the company's own zone

interface DeletionSectionProps {
  rows: CompanyDeletionRow[]
  /** True when the companyDeletions read failed — must not render as "nothing on gång". */
  historyUnavailable: boolean
  /** Admins remaining in the company right now. Null when that read failed
   *  or is not applicable (company doc doesn't exist — handled by
   *  DeletedCompanyView instead, this section is only mounted for a company
   *  that still exists). */
  adminCount: number | null
}

export default function DeletionSection({ rows, historyUnavailable, adminCount }: DeletionSectionProps) {
  const now = nowMs()
  const latest = rows[0]
  const isActive = latest && (latest.state === 'requested' || latest.state === 'executing' || latest.state === 'failed')
  const stuck = latest ? isStuckDeletion(latest, now) : false
  const remaining = latest && latest.state === 'requested' ? timeRemaining(latest.scheduledFor, now) : null
  const noAdminsLeft = isActive && latest.state === 'requested' && adminCount === 0

  return (
    <div className={styles.deletionSection}>
      <span className={styles.sectionLabel}>COMPANY DELETION</span>

      {historyUnavailable ? (
        <div className={styles.statusCallout}>
          <span className={styles.metaLine}>Deletion history could not be loaded right now.</span>
        </div>
      ) : !isActive ? (
        <div className={styles.statusCallout}>
          <Chip size="tag" interactive={false} tone="neutral">NOTHING PENDING</Chip>
          <span className={styles.metaLine}>
            {rows.length > 0 ? 'No deletion is currently in progress — see history below.' : 'No deletion has ever been requested for this company.'}
          </span>
        </div>
      ) : (
        <div className={`${styles.statusCallout} ${styles.statusCalloutDanger}`}>
          <Chip size="tag" interactive={false} tone="danger">
            {latest.state === 'requested' ? 'DELETION REQUESTED' : latest.state === 'executing' ? 'EXECUTING' : 'FAILED'}
          </Chip>
          {stuck && <Chip size="tag" interactive={false} tone="danger">STUCK</Chip>}
          {latest.state === 'requested' && remaining && (
            <span className={styles.remaining}>
              Scheduled for {formatDateFullInZone(latest.scheduledFor, ZONE)} — {remaining.label}
            </span>
          )}
          {latest.state !== 'requested' && (
            <span className={styles.metaLine}>Cannot be stopped from the customer&apos;s own product surfaces any more.</span>
          )}
        </div>
      )}

      {noAdminsLeft && (
        <div className={styles.noAdminsNotice}>
          No administrators remain in this company — only support can stop this deletion.
        </div>
      )}
      {isActive && latest.state === 'requested' && adminCount !== null && adminCount > 0 && (
        <span className={styles.metaLine}>
          {adminCount} administrator{adminCount === 1 ? '' : 's'} remaining — any of them can cancel this from the product.
        </span>
      )}
      {isActive && latest.state === 'requested' && adminCount === null && (
        <span className={styles.metaLine}>Administrator count could not be read right now.</span>
      )}

      <span className={styles.sectionLabelSmall}>HISTORY</span>
      {historyUnavailable ? (
        <span className={styles.metaLine}>History unavailable right now.</span>
      ) : (
        <DeletionHistoryList
          rows={rows}
          emptyHeading="No deletion history"
          emptyBody="This company has never had a deletion requested."
        />
      )}
    </div>
  )
}
