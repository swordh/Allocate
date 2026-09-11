import { getOperatorSession } from '@/lib/operator-dal'
import { adminDb } from '@/lib/firebase-admin'
import { iso, isoOrNull } from '@/lib/firestore-timestamps'
import CustomersListView, { type SelectedDetail, type TeamMember } from './CustomersListView'
import {
  SEGMENTS,
  SORTS,
  PLANS,
  type CompanyRow,
  type Segment,
  type Sort,
  type PlanFilter,
} from '@/types/operator'

const DAY_MS = 24 * 60 * 60 * 1000

function matchesSegment(row: CompanyRow, segment: Segment, now: number): boolean {
  switch (segment) {
    case 'all':
      return true
    case 'active':
    case 'trialing':
    case 'past_due':
    case 'canceled':
      return row.subscriptionStatus === segment
    case 'trial_ending': {
      if (row.subscriptionStatus !== 'trialing' || !row.trialEnd) return false
      const endsIn = new Date(row.trialEnd).getTime() - now
      return endsIn >= 0 && endsIn <= 7 * DAY_MS
    }
    case 'no_bookings_30d': {
      // A company without stats has an unknown last booking. Claiming it is
      // inactive would be a guess; the banner reports these separately instead.
      if (!row.hasStats) return false
      if (row.lastBookingAt === null) return true
      return now - new Date(row.lastBookingAt).getTime() > 30 * DAY_MS
    }
  }
}

function sortRows(rows: CompanyRow[], sort: Sort): CompanyRow[] {
  const copy = [...rows]
  switch (sort) {
    case 'name':
      return copy.sort((a, b) => a.name.localeCompare(b.name))
    case 'signed_up':
      return copy.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    case 'members':
      return copy.sort((a, b) => (b.memberCount ?? -1) - (a.memberCount ?? -1))
    case 'last_booking':
    default:
      return copy.sort((a, b) => {
        const bt = b.lastBookingAt ? new Date(b.lastBookingAt).getTime() : -1
        const at = a.lastBookingAt ? new Date(a.lastBookingAt).getTime() : -1
        return bt - at
      })
  }
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; segment?: string; plan?: string; sort?: string; selected?: string }>
}) {
  await getOperatorSession()
  const { q, segment: segmentParam, plan: planParam, sort: sortParam, selected: selectedParam } =
    await searchParams

  const segment: Segment = SEGMENTS.includes(segmentParam as Segment)
    ? (segmentParam as Segment)
    : 'all'
  const plan: PlanFilter | null = PLANS.includes(planParam as PlanFilter)
    ? (planParam as PlanFilter)
    : null
  const sort: Sort = SORTS.includes(sortParam as Sort) ? (sortParam as Sort) : 'last_booking'

  // One query, no per-row subcollection reads. Everything the list shows now
  // lives on the company document, denormalized by lib/companyStats.ts.
  //
  // No `.limit()` — filtering/sorting happen in memory below. That's correct
  // at 4 companies and still correct at a few hundred, but it stops being
  // correct somewhere in the low thousands: a full unfiltered `.get()` scan
  // on every request. When that day comes, the fix is cursor-based
  // pagination, or a slimmer per-row projection for the list with the full
  // document fetched only for the selected row.
  const snapshot = await adminDb.collection('companies').orderBy('createdAt', 'desc').get()

  const rows: CompanyRow[] = snapshot.docs.map((doc) => {
    const data = doc.data()
    const stats = data.stats

    return {
      id: doc.id,
      name: data.name ?? '',
      createdAt: iso(data.createdAt),
      stripeCustomerId: data.stripeCustomerId ?? '',
      subscriptionStatus: data.subscription?.status ?? 'unknown',
      subscriptionPlan: data.subscription?.plan ?? '',
      currentPeriodEnd: iso(data.subscription?.currentPeriodEnd),
      trialEnd: isoOrNull(data.subscription?.trialEnd),
      cancelAtPeriodEnd: data.subscription?.cancelAtPeriodEnd ?? false,
      hadTrial: data.hadTrial ?? false,
      equipmentCount: stats?.equipmentCount ?? null,
      bookingsCreated: stats?.bookingsCreated ?? null,
      bookingsCancelled: stats?.bookingsCancelled ?? null,
      lastBookingAt: stats ? isoOrNull(stats.lastBookingAt) : null,
      memberCount: stats?.memberCount ?? null,
      hasStats: stats !== undefined,
      // Missing limits (see types/operator.ts) must render as unknown, not
      // as a fabricated 0-unit plan — same `typeof` guard actions/team.ts's
      // seat guard uses for the same field.
      limits: {
        equipment: typeof data.subscription?.limits?.equipment === 'number'
          ? data.subscription.limits.equipment
          : null,
        users: typeof data.subscription?.limits?.users === 'number'
          ? data.subscription.limits.users
          : null,
      },
    }
  })

  const now = Date.now()
  const needle = q?.trim().toLowerCase() ?? ''

  const filtered = sortRows(
    rows.filter((row) => {
      if (needle && !row.name.toLowerCase().includes(needle)) return false
      if (plan && row.subscriptionPlan !== plan) return false
      return matchesSegment(row, segment, now)
    }),
    sort,
  )

  // Selection from the prototype: if the selected row falls out of the
  // current filter (or none was ever chosen), fall back to the first
  // remaining row rather than showing an empty detail panel.
  const selectedId =
    selectedParam && filtered.some((r) => r.id === selectedParam)
      ? selectedParam
      : filtered[0]?.id

  let selectedDetail: SelectedDetail | null = null
  if (selectedId) {
    // The members read is scoped to the selected company only, but it still
    // runs on every list render (any segment/plan/sort/search change keeps
    // a selection). A failure here must not take the whole page down with
    // it — the list itself never needed this read. Degrade to the detail
    // panel rendering without its team section instead; CustomersListView
    // shows "Team data unavailable" in that case rather than a false "No
    // members".
    let team: TeamMember[] | null = []
    try {
      const membersSnap = await adminDb.collection(`companies/${selectedId}/members`).get()
      team = membersSnap.docs.map((m) => ({
        uid: m.id,
        name: m.data().name ?? '',
        email: m.data().email ?? '',
        role: m.data().role ?? '',
      }))
    } catch (err) {
      console.error('[operator/customers] members_fetch_failed', { companyId: selectedId, err })
      team = null
    }

    // Notes moved from a plain `opsNotes` string field (readable by any
    // member of the company — see firestore.rules history) to a top-level
    // `operatorNotes` collection with no client-facing rule. This panel is
    // read-only, so it only needs the newest note; the full thread and the
    // composer live on screen 22 (CustomerDetailView).
    let notes = ''
    try {
      const notesSnap = await adminDb
        .collection('operatorNotes')
        .where('companyId', '==', selectedId)
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get()
      notes = notesSnap.docs[0]?.data()?.text ?? ''
    } catch (err) {
      console.error('[operator/customers] notes_fetch_failed', { companyId: selectedId, err })
    }

    selectedDetail = { notes, team }
  }

  // Firestore cannot query for a missing field, so the only way to know how many
  // companies the backfill has not reached is to count them here.
  const unmigrated = rows.filter((r) => !r.hasStats).length

  return (
    <CustomersListView
      rows={filtered}
      query={q ?? ''}
      segment={segment}
      plan={plan}
      sort={sort}
      totalCount={rows.length}
      unmigratedCount={unmigrated}
      selectedId={selectedId ?? null}
      selectedDetail={selectedDetail}
    />
  )
}
