import Link from 'next/link'
import Chip from '@/components/ui/Chip'
import EmptyState from '@/components/ui/EmptyState'
import { adminAuth } from '@/lib/firebase-admin'
import { formatDateFullInZone } from '@/lib/dates'
import { getOperatorSession } from '@/lib/operator-dal'
import {
  queryAllDeletions,
  queryDeletionsByStates,
  queryStuckAccountDeletions,
  LIST_VIEW_LIMIT,
} from '@/lib/operatorDeletionQueries'
import { isStuckDeletion, nowMs } from '@/lib/operatorDeletionView'
import {
  ACCOUNT_DELETION_FAILURE_PATH_LABELS,
  DELETION_SEGMENTS,
  DELETION_SEGMENT_LABELS,
  type CompanyDeletionRow,
  type DeletionSegment,
  type StuckAccountDeletionRow,
} from '@/types/operator'
import DeletionHistoryList from '../customers/[companyId]/DeletionHistoryList'
import styles from './deletions.module.css'

/**
 * Same zone choice as `DeletionHistoryList` — see that file's `ZONE` docblock
 * for why UTC, not any one company's own timezone, is the only zone every
 * row on a site-wide operator list agrees on.
 */
const STUCK_ZONE = 'UTC'

type StuckAccountDeletionDisplayRow = StuckAccountDeletionRow & {
  email: string | null
  /** `false` means `adminAuth.getUser` came back not-found — the account is
   *  already gone, distinct from "found, but has no email on file". */
  accountExists: boolean
}

/**
 * Resolves each row's email via `adminAuth.getUser`, in parallel — same
 * try/catch-per-row pattern as app/operator/(protected)/feedback/page.tsx
 * (~:111), which already handles the same "user may have been deleted" case.
 * Parallel because this list can be up to `LIST_VIEW_LIMIT` rows and nothing
 * here depends on a previous row's result.
 */
async function resolveStuckAccountEmails(
  rows: StuckAccountDeletionRow[],
): Promise<StuckAccountDeletionDisplayRow[]> {
  return Promise.all(
    rows.map(async (row) => {
      try {
        const user = await adminAuth.getUser(row.uid)
        return { ...row, email: user.email ?? null, accountExists: true }
      } catch {
        // Not fatal — the account was deleted (successfully, elsewhere, or by
        // an operator) since this trace was last written. Not fatal, and not
        // even unexpected: a trace only disappears when *this* uid's own
        // deletion succeeds, but nothing stops the sweep or an operator from
        // deleting the same account through a different path first.
        return { ...row, email: null, accountExists: false }
      }
    }),
  )
}

function StuckAccountDeletionRowView({ row }: { row: StuckAccountDeletionDisplayRow }) {
  return (
    <div className={styles.stuckRow}>
      <div className={styles.stuckRowHeader}>
        <span className={styles.metaLine}>
          {row.accountExists ? row.email || '(no email on file)' : 'Account no longer exists'}
        </span>
        <span className={styles.metaLineFaint}>{row.uid}</span>
      </div>
      <div className={styles.stuckRowBody}>
        <span className={styles.metaLine}>
          First attempt {formatDateFullInZone(row.firstAt, STUCK_ZONE)} · last {formatDateFullInZone(row.lastAt, STUCK_ZONE)}
        </span>
        <span className={styles.metaLine}>
          {row.attempts} {row.attempts === 1 ? 'attempt' : 'attempts'} · {ACCOUNT_DELETION_FAILURE_PATH_LABELS[row.lastPath]}
          {row.lastErrorCode ? ` · ${row.lastErrorCode}` : ''}
        </span>
        {row.lastCompanyIds.length > 0 && (
          <span className={styles.metaLine}>
            Companies:{' '}
            {row.lastCompanyIds.map((companyId, i) => (
              <span key={companyId}>
                {i > 0 && ', '}
                <Link href={`/operator/customers/${companyId}`} className={styles.companyLink}>
                  {companyId}
                </Link>
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * The two site-wide entry points the design brief requires (issue #252 step
 * 6, PR 4), built as one segmented list rather than two separate pages —
 * the same pattern /operator/customers and /operator/feedback already use
 * for their own filter chips, so this page doesn't introduce a third way of
 * doing the same thing:
 *
 * - `active`  — "someone got in touch, something's wrong": every deletion
 *   currently in flight, the way a support ticket about this usually starts.
 * - `stuck`   — nobody reports this on their own; it has to be discoverable
 *   by browsing. See lib/operatorDeletionView.ts's `isStuckDeletion`.
 * - `all`     — the full ledger, for browsing a completed or canceled
 *   history that isn't currently active or stuck. Not required by the
 *   brief in so many words, but it falls out of the same query shape for
 *   free and is the only way to find a company's history from here without
 *   already knowing its id.
 *
 * `active` is the default landing segment, matching the support-ticket
 * framing above being the more common reason to land here.
 */
export default async function DeletionsPage({
  searchParams,
}: {
  searchParams: Promise<{ segment?: string }>
}) {
  await getOperatorSession()
  const { segment: segmentParam } = await searchParams
  const segment: DeletionSegment = DELETION_SEGMENTS.includes(segmentParam as DeletionSegment)
    ? (segmentParam as DeletionSegment)
    : 'active'

  const now = nowMs()
  let rows: CompanyDeletionRow[]
  let unavailable = false
  try {
    if (segment === 'active') {
      rows = await queryDeletionsByStates(['requested', 'executing'])
    } else if (segment === 'stuck') {
      // Coarse pre-filter at the query level (`failed` or `executing`),
      // refined here with the exact same `isStuckDeletion` predicate the
      // per-company page uses — see lib/operatorDeletionQueries.ts's
      // docblock on `queryDeletionsByStates` for why this can't be a single
      // Firestore query.
      const candidates = await queryDeletionsByStates(['failed', 'executing'])
      rows = candidates.filter((r) => isStuckDeletion(r, now))
    } else {
      rows = await queryAllDeletions()
    }
  } catch (err) {
    console.error('[operator/deletions] read_failed', { segment, err })
    rows = []
    unavailable = true
  }

  const capped = rows.length === LIST_VIEW_LIMIT

  // ── Stuck account deletions (issue #337 step 1) ───────────────────────────
  // Independent of the `segment` above — own read, own try/catch, rendered
  // regardless of which company-deletion segment is selected. A failure here
  // must not take down the section above it, or vice versa.
  let stuckRows: StuckAccountDeletionDisplayRow[] = []
  let stuckUnavailable = false
  try {
    const traces = await queryStuckAccountDeletions()
    stuckRows = await resolveStuckAccountEmails(traces)
  } catch (err) {
    console.error('[operator/deletions] stuck_account_read_failed', { err })
    stuckUnavailable = true
  }
  const stuckCapped = stuckRows.length === LIST_VIEW_LIMIT

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <span className={styles.title}>COMPANY DELETIONS</span>
      </div>

      <div className={styles.segmentRow}>
        {DELETION_SEGMENTS.map((s) => (
          <Link key={s} href={s === 'active' ? '/operator/deletions' : `/operator/deletions?segment=${s}`}>
            <Chip interactive={false} active={s === segment} tone={s === 'stuck' ? 'danger' : 'neutral'}>
              {DELETION_SEGMENT_LABELS[s]}
            </Chip>
          </Link>
        ))}
      </div>

      {unavailable ? (
        <EmptyState
          variant="framed"
          heading="Could not load deletions right now"
          body="Something went wrong reading the deletion ledger. Try again shortly — this is not a claim that nothing is happening."
        />
      ) : (
        <DeletionHistoryList
          rows={rows}
          showCompanyName
          linkToCompany
          emptyHeading={
            segment === 'active'
              ? 'No deletions in progress'
              : segment === 'stuck'
                ? 'Nothing is stuck right now'
                : 'No deletion history yet'
          }
          emptyBody={segment === 'stuck' ? 'Every deletion is either idle or progressing normally.' : undefined}
        />
      )}

      {capped && !unavailable && (
        <p className={styles.cappedNotice}>
          Showing the most recent {LIST_VIEW_LIMIT} rows only — older entries exist but aren&apos;t shown.
        </p>
      )}

      <div className={styles.stuckSection}>
        <span className={styles.title}>STUCK ACCOUNT DELETIONS</span>
        <p className={styles.stuckIntro}>
          These users hit &quot;could not verify your company administrators&quot; when trying to delete their own
          account. Read-only — an entry disappears once that user&apos;s deletion succeeds, or after 90 days with no
          new attempt.
        </p>

        {stuckUnavailable ? (
          <EmptyState
            variant="framed"
            heading="Could not load stuck account deletions right now"
            body="Something went wrong reading the trace collection. Try again shortly — this is not a claim that nothing is stuck."
          />
        ) : stuckRows.length === 0 ? (
          <EmptyState variant="inline" heading="No stuck account deletions" />
        ) : (
          <div className={styles.stuckList}>
            {stuckRows.map((row) => (
              <StuckAccountDeletionRowView key={row.uid} row={row} />
            ))}
          </div>
        )}

        {stuckCapped && !stuckUnavailable && (
          <p className={styles.cappedNotice}>
            Showing the most recent {LIST_VIEW_LIMIT} rows only — older entries exist but aren&apos;t shown.
          </p>
        )}
      </div>
    </div>
  )
}
