import Link from 'next/link'
import Chip from '@/components/ui/Chip'
import EmptyState from '@/components/ui/EmptyState'
import DeletionHistoryList from './DeletionHistoryList'
import type { CompanyDeletionRow } from '@/types/operator'
import styles from './deletion.module.css'

/**
 * What the per-company detail page renders when `companies/{companyId}`
 * no longer exists but `companyDeletions` still has rows for it — i.e. a
 * completed purge. See page.tsx's comment on why this is NOT a 404: the
 * ledger is designed to survive the company doc precisely so this page can
 * still answer "what happened to this company" (design brief: "Att
 * företaget är raderat ... ska synas att det inte går [att göra något åt
 * det]"). Every subcollection the rest of this page would normally read
 * (members, bookings, notes, plan events) is gone along with the company
 * doc, so this is deliberately a much smaller page than CustomerDetailView
 * — there is nothing else left to show.
 */
export default function DeletedCompanyView({ companyId, rows }: { companyId: string; rows: CompanyDeletionRow[] }) {
  const latest = rows[0]
  const companyName = latest?.companyName || companyId

  return (
    <div className={styles.deletedPage}>
      <Link href="/operator/customers" className={styles.metaLine}>← ALL CUSTOMERS</Link>

      <EmptyState
        variant="framed"
        eyebrow="COMPANY DELETED"
        heading={companyName}
        // Deliberately scoped to "this company's product data" — invoicing
        // records survive a completed purge for accounting reasons (design
        // brief: "fakturaunderlaget kvar av bokföringsskäl ... får inte
        // framställas som borttaget") and are outside this product entirely,
        // so this text must not claim "everything" is gone.
        body="This company's product data has been deleted and cannot be recovered or undone — the deletion history below is all that remains here. Billing records are retained separately for accounting purposes and are not shown in this product."
        action={<Chip size="tag" interactive={false} tone="danger">DELETED</Chip>}
      />

      <span className={styles.sectionLabelSmall}>HISTORY</span>
      <DeletionHistoryList
        rows={rows}
        emptyHeading="No history"
      />
    </div>
  )
}
