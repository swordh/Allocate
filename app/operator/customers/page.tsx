import { getOperatorSession } from '@/lib/operator-dal'
import { adminDb } from '@/lib/firebase-admin'
import CustomersListView from './CustomersListView'
import { SEGMENTS, type CompanyRow, type Segment } from '@/types/operator'

const DAY_MS = 24 * 60 * 60 * 1000

function iso(value: unknown): string {
  const v = value as { toDate?: () => Date } | string | undefined
  if (!v) return ''
  if (typeof v === 'string') return v
  return v.toDate?.().toISOString() ?? ''
}

function isoOrNull(value: unknown): string | null {
  return iso(value) || null
}

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

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; segment?: string }>
}) {
  await getOperatorSession()
  const { q, segment: segmentParam } = await searchParams

  const segment: Segment = SEGMENTS.includes(segmentParam as Segment)
    ? (segmentParam as Segment)
    : 'all'

  // One query, no per-row subcollection reads. Everything the list shows now
  // lives on the company document, denormalized by lib/companyStats.ts.
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
      lastBookingAt: stats ? isoOrNull(stats.lastBookingAt) : null,
      hasStats: stats !== undefined,
    }
  })

  const now = Date.now()
  const needle = q?.trim().toLowerCase() ?? ''

  const filtered = rows.filter((row) => {
    if (needle && !row.name.toLowerCase().includes(needle)) return false
    return matchesSegment(row, segment, now)
  })

  // Firestore cannot query for a missing field, so the only way to know how many
  // companies the backfill has not reached is to count them here.
  const unmigrated = rows.filter((r) => !r.hasStats).length

  return (
    <CustomersListView
      rows={filtered}
      query={q ?? ''}
      segment={segment}
      totalCount={rows.length}
      unmigratedCount={unmigrated}
    />
  )
}
