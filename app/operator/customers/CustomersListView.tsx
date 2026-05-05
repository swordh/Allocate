'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { CompanyRow } from '@/types/operator'
import styles from './customers.module.css'

interface CustomersListViewProps {
  rows: CompanyRow[]
  query: string
}

function formatDate(iso: string): string {
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

export default function CustomersListView({ rows, query }: CustomersListViewProps) {
  const router = useRouter()

  function handleSearch(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    if (value) {
      router.replace(`/operator/customers?q=${encodeURIComponent(value)}`)
    } else {
      router.replace('/operator/customers')
    }
  }

  return (
    <div>
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
              <th className={styles.th}>Period End</th>
              <th className={styles.th}>Created</th>
              <th className={styles.th}>Members</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className={styles.td} colSpan={6}>
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
                  <td className={styles.td}>{formatDate(row.currentPeriodEnd)}</td>
                  <td className={styles.td}>{formatDate(row.createdAt)}</td>
                  <td className={styles.td}>{row.memberCount}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
