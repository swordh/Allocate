import Link from 'next/link'
import Chip from '@/components/ui/Chip'
import EmptyState from '@/components/ui/EmptyState'
import { isStuckDeletion, nowMs } from '@/lib/operatorDeletionView'
import { MarkFailedBlock, RequeueBlock } from './DeletionActionBlocks'
import DeletionHistoryList from './DeletionHistoryList'
import type { CompanyDeletionRow } from '@/types/operator'
import styles from './deletion.module.css'

/**
 * What the per-company detail page renders when `companies/{companyId}`
 * no longer exists but `companyDeletions` still has rows for it. This used
 * to mean only "a completed purge" — issue #331/#335 added a second reading:
 * `runFinalizePhase` (functions/src/company/purge.ts) deletes the company
 * document BEFORE writing `state: 'completed'` on the ledger, and a crash in
 * that exact window leaves a row that can still go `failed` (attempts
 * exhausted, or `claimStaleLease`'s no-progress detection) — or sit stuck
 * `executing` — with the company doc ALREADY gone. So this view renders
 * `RequeueBlock`/`MarkFailedBlock` for exactly those two cases, the same way
 * `DeletionSection.tsx` does for a company that still exists; neither action
 * needs a company document to act on, only the ledger.
 *
 * See page.tsx's comment on why this is NOT a 404: the ledger is designed to
 * survive the company doc precisely so this page can still answer "what
 * happened to this company" (design brief: "Att företaget är raderat ...
 * ska synas att det inte går [att göra något åt det]"). Every subcollection
 * the rest of this page would normally read (members, bookings, notes, plan
 * events) is gone along with the company doc, so this is deliberately a much
 * smaller page than CustomerDetailView — there is nothing else left to show.
 */
export default function DeletedCompanyView({ companyId, rows }: { companyId: string; rows: CompanyDeletionRow[] }) {
  const latest = rows[0]
  const companyName = latest?.companyName || companyId
  const stuck = latest ? isStuckDeletion(latest, nowMs()) : false

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

      {latest && latest.state === 'failed' && <RequeueBlock requestId={latest.requestId} />}
      {latest && latest.state === 'executing' && stuck && <MarkFailedBlock requestId={latest.requestId} />}

      <span className={styles.sectionLabelSmall}>HISTORY</span>
      <DeletionHistoryList
        rows={rows}
        emptyHeading="No history"
      />
    </div>
  )
}
