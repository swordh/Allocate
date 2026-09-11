'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { SEGMENTS, SEGMENT_LABELS, type CompanyRow, type Segment } from '@/types/operator'
import layoutStyles from '@/app/operator/layout.module.css'
import styles from './customers.module.css'

interface CustomersListViewProps {
  rows: CompanyRow[]
  query: string
  segment: Segment
  totalCount: number
  unmigratedCount: number
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

function statusClass(status: string): string {
  switch (status) {
    case 'active':    return styles.statusActive
    case 'trialing':  return styles.statusTrialing
    case 'past_due':  return styles.statusPastDue
    case 'canceled':  return styles.statusCanceled
    default:          return styles.statusUnknown
  }
}

function href(segment: Segment, query: string): string {
  const params = new URLSearchParams()
  if (segment !== 'all') params.set('segment', segment)
  if (query) params.set('q', query)
  const qs = params.toString()
  return qs ? `/operator/customers?${qs}` : '/operator/customers'
}

/** Null means the backfill has not reached this company — not zero. */
function Count({ value }: { value: number | null }) {
  if (value === null) return <span className={styles.unknown}>—</span>
  return <span className={styles.num}>{value}</span>
}

export default function CustomersListView({
  rows,
  query,
  segment,
  totalCount,
  unmigratedCount,
}: CustomersListViewProps) {
  const router = useRouter()

  function handleSearch(e: React.ChangeEvent<HTMLInputElement>) {
    router.replace(href(segment, e.target.value))
  }

  return (
    // legacyPad: interim, dropped when this screen is rebuilt to the phase 5
    // design (see app/operator/layout.module.css).
    <div className={layoutStyles.legacyPad}>
      <div className={styles.segments}>
        {SEGMENTS.map((s) => (
          <Link
            key={s}
            href={href(s, query)}
            className={s === segment ? `${styles.segment} ${styles.segmentActive}` : styles.segment}
          >
            {SEGMENT_LABELS[s]}
            {s === 'all' && <span className={styles.segmentCount}>{totalCount}</span>}
          </Link>
        ))}
      </div>

      {unmigratedCount > 0 && (
        <div className={styles.banner}>
          {unmigratedCount} of {totalCount} companies have no stats yet and are excluded from
          the <strong>{SEGMENT_LABELS.no_bookings_30d}</strong> segment. Run{' '}
          <code>tools/backfill_company_stats.js --project=&lt;id&gt; --yes</code> to populate them.
        </div>
      )}

      <div className={styles.searchBar}>
        <input
          className={styles.searchInput}
          type="search"
          placeholder="Search companies…"
          defaultValue={query}
          onChange={handleSearch}
        />
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th}>Company</th>
              <th className={styles.th}>Status</th>
              <th className={styles.th}>Plan</th>
              <th className={styles.th}>Equipment</th>
              <th className={styles.th}>Bookings</th>
              <th className={styles.th}>Last booking</th>
              <th className={styles.th}>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className={styles.td} colSpan={7}>
                  <span className={styles.emptyState}>No customers found</span>
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className={styles.tr}>
                  <td className={styles.td}>
                    <Link
                      href={`/operator/customers/${row.id}`}
                      className={styles.companyLink}
                    >
                      {row.name || '(unnamed)'}
                    </Link>
                  </td>
                  <td className={styles.td}>
                    <span className={statusClass(row.subscriptionStatus)}>
                      {row.subscriptionStatus}
                    </span>
                  </td>
                  <td className={styles.td}>{row.subscriptionPlan || '—'}</td>
                  <td className={styles.td}><Count value={row.equipmentCount} /></td>
                  <td className={styles.td}><Count value={row.bookingsCreated} /></td>
                  <td className={styles.td}>
                    {row.hasStats
                      ? formatDate(row.lastBookingAt)
                      : <span className={styles.unknown}>—</span>}
                  </td>
                  <td className={styles.td}>{formatDate(row.createdAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
