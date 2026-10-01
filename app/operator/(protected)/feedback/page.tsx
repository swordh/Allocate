import { getOperatorSession } from '@/lib/operator-dal'
import { adminDb, adminAuth } from '@/lib/firebase-admin'
import { iso } from '@/lib/firestore-timestamps'
import FeedbackListView from './FeedbackListView'
import {
  FEEDBACK_STATUS_FILTERS,
  FEEDBACK_TYPE_FILTERS,
  FEEDBACK_SORTS,
  FEEDBACK_STATUSES,
  type OperatorFeedback,
  type FeedbackStatusFilter,
  type FeedbackTypeFilter,
  type FeedbackSort,
  type FeedbackTimelineEntry,
} from '@/types/operator'

// 'unknown' (see types/operator.ts) sorts first, not last — a corrupt
// document should surface at the top of a priority sort, not hide at the
// bottom where it's least likely to be noticed.
const PRIORITY_ORDER = { unknown: -1, high: 0, medium: 1, low: 2 }

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; type?: string; sort?: string; selected?: string }>
}) {
  await getOperatorSession()
  const { q, status: statusParam, type: typeParam, sort: sortParam, selected: selectedParam } = await searchParams

  const status: FeedbackStatusFilter = FEEDBACK_STATUS_FILTERS.includes(statusParam as FeedbackStatusFilter)
    ? (statusParam as FeedbackStatusFilter)
    : 'all'
  const type: FeedbackTypeFilter = FEEDBACK_TYPE_FILTERS.includes(typeParam as FeedbackTypeFilter)
    ? (typeParam as FeedbackTypeFilter)
    : 'all'
  const sort: FeedbackSort = FEEDBACK_SORTS.includes(sortParam as FeedbackSort)
    ? (sortParam as FeedbackSort)
    : 'newest'

  // One query over the whole collection, same data discipline as screen 21
  // (app/operator/customers/page.tsx) — filtering/sorting happen in memory.
  // Per-item extras (notes, submitter email) are fetched only for the
  // selected item below, not for every row.
  const snapshot = await adminDb.collection('operatorFeedback').orderBy('submittedAt', 'desc').get()

  const all: OperatorFeedback[] = snapshot.docs.map((doc) => {
    const d = doc.data()
    return {
      id: doc.id,
      // Explicit fallback, never a falsy check — same discipline as `kind ??
      // 'note'` on the timeline. Unlike that case, 'unknown' is deliberately
      // NOT a plausible real value (see the doc comment on these types in
      // types/operator.ts): a document missing type/status/priority should
      // render as visibly corrupt, not quietly pass for a normal ticket.
      type: d.type ?? 'unknown',
      title: d.title ?? '',
      description: d.description ?? '',
      submittedAt: iso(d.submittedAt),
      submittedBy: d.submittedBy ?? '',
      userEmail: '',
      companyId: d.companyId ?? '',
      companyName: d.companyName ?? '',
      userName: d.userName ?? '',
      status: d.status ?? 'unknown',
      priority: d.priority ?? 'unknown',
    }
  })

  // Sidebar counts are always against the full unfiltered set (matches the
  // design's `renderVals()`, which counts `all`, never the filtered view) —
  // a "5 Open" count should not shrink just because a search term is typed.
  const statusCounts: Record<string, number> = { all: all.length }
  for (const s of FEEDBACK_STATUSES) statusCounts[s] = all.filter((i) => i.status === s).length
  const typeCounts: Record<string, number> = {
    all: all.length,
    feature_request: all.filter((i) => i.type === 'feature_request').length,
    bug_report: all.filter((i) => i.type === 'bug_report').length,
    support: all.filter((i) => i.type === 'support').length,
  }

  const needle = q?.trim().toLowerCase() ?? ''
  let filtered = all.filter(
    (i) =>
      (status === 'all' || i.status === status) &&
      (type === 'all' || i.type === type) &&
      (!needle ||
        i.title.toLowerCase().includes(needle) ||
        i.companyName.toLowerCase().includes(needle) ||
        i.userName.toLowerCase().includes(needle)),
  )
  if (sort === 'priority') {
    filtered = [...filtered].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])
  } else if (sort === 'company') {
    filtered = [...filtered].sort((a, b) => a.companyName.localeCompare(b.companyName, 'sv'))
  }
  // 'newest' needs no re-sort — the source query is already `submittedAt desc`
  // and filtering preserves order.

  const selectedId =
    selectedParam && filtered.some((i) => i.id === selectedParam) ? selectedParam : (filtered[0]?.id ?? null)

  let selectedItem: OperatorFeedback | null = null
  let selectedNotes: FeedbackTimelineEntry[] = []

  if (selectedId) {
    selectedItem = filtered.find((i) => i.id === selectedId) ?? null

    // Matches screen 21's discipline: this row's extra reads run only for
    // the selected item, not for every row in the list.
    if (selectedItem?.submittedBy) {
      try {
        const userRecord = await adminAuth.getUser(selectedItem.submittedBy)
        selectedItem = { ...selectedItem, userEmail: userRecord.email ?? '' }
      } catch {
        // user may have been deleted — not fatal, leave userEmail blank
      }
    }

    // The list panel shows plain notes only (no interleaved status/priority
    // events) — that's the full interleaved thread on screen 24, not here.
    // Newest first, same order the customer detail screen's notes list uses
    // (opposite of screen 24's ascending thread — see that screen's brief).
    const notesSnap = await adminDb
      .collection(`operatorFeedback/${selectedId}/notes`)
      .orderBy('createdAt', 'desc')
      .get()
    selectedNotes = notesSnap.docs
      .map((n) => {
        const d = n.data()
        // Explicit fallback, never a falsy check — see FeedbackTimelineEntry's
        // doc comment in types/operator.ts.
        const kind = (d.kind ?? 'note') as 'note' | 'event'
        return {
          id: n.id,
          kind,
          text: d.text ?? '',
          createdAt: iso(d.createdAt),
          createdBy: d.createdBy ?? '',
        } as FeedbackTimelineEntry
      })
      .filter((n): n is FeedbackTimelineEntry & { kind: 'note' } => n.kind === 'note')
  }

  return (
    <FeedbackListView
      items={filtered}
      allCount={all.length}
      statusCounts={statusCounts}
      typeCounts={typeCounts}
      query={q ?? ''}
      status={status}
      type={type}
      sort={sort}
      selectedId={selectedId}
      selectedItem={selectedItem}
      selectedNotes={selectedNotes}
    />
  )
}
