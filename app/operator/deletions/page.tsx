import Link from 'next/link'
import Chip from '@/components/ui/Chip'
import EmptyState from '@/components/ui/EmptyState'
import { getOperatorSession } from '@/lib/operator-dal'
import { queryAllDeletions, queryDeletionsByStates, LIST_VIEW_LIMIT } from '@/lib/operatorDeletionQueries'
import { isStuckDeletion, nowMs } from '@/lib/operatorDeletionView'
import { DELETION_SEGMENTS, DELETION_SEGMENT_LABELS, type DeletionSegment, type CompanyDeletionRow } from '@/types/operator'
import DeletionHistoryList from '../customers/[companyId]/DeletionHistoryList'
import styles from './deletions.module.css'

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
    </div>
  )
}
