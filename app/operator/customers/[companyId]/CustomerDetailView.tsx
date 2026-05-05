'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { updateOperatorNotes } from './actions'
import styles from './detail.module.css'

interface Subscription {
  status: string
  plan: string
  currentPeriodEnd: string
  cancelAtPeriodEnd: boolean
  trialEnd: string | null
  interval: string | null
  limits: { equipment: number; users: number }
  stripeSubscriptionId: string | null
}

interface Company {
  id: string
  name: string
  createdAt: string
  stripeCustomerId: string
  hadTrial: boolean
  opsNotes: string
  subscription: Subscription
}

interface Member {
  uid: string
  name: string
  email: string
  role: string
  joinedAt: string
}

interface Stats {
  bookings: number
  equipment: number
  lastBookingAt: string | null
}

interface CustomerDetailViewProps {
  company: Company
  members: Member[]
  stats: Stats
  activeTab: string
}

const TABS = [
  { key: 'overview',  label: 'Overview'  },
  { key: 'activity',  label: 'Activity'  },
  { key: 'notes',     label: 'Notes'     },
]

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

function statusClass(status: string): string {
  switch (status) {
    case 'active':   return styles.infoValueAccent
    case 'trialing': return styles.infoValueTrialing
    case 'past_due': return styles.infoValueError
    case 'canceled': return styles.infoValueMuted
    default:         return styles.infoValueMuted
  }
}

export default function CustomerDetailView({
  company,
  members,
  stats,
  activeTab,
}: CustomerDetailViewProps) {
  const router = useRouter()
  const [notes, setNotes] = useState(company.opsNotes)
  const [saving, setSaving] = useState(false)

  function handleTabClick(key: string) {
    router.replace(`/operator/customers/${company.id}?tab=${key}`)
  }

  async function handleNotesBlur() {
    if (notes === company.opsNotes) return
    setSaving(true)
    await updateOperatorNotes(company.id, notes)
    setSaving(false)
  }

  return (
    <div>
      <Link href="/operator/customers" className={styles.backLink}>
        <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>arrow_back</span>
        Customers
      </Link>

      <h1 className={styles.title}>{company.name || '(unnamed)'}</h1>

      <div className={styles.tabs}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`${styles.tab} ${activeTab === t.key ? styles.tabActive : ''}`}
            onClick={() => handleTabClick(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div>
          <div className={styles.infoGrid}>
            {/* Left column */}
            <div className={styles.infoBlock}>
              <div className={styles.infoRow}>
                <p className={styles.infoLabel}>Company Name</p>
                <p className={styles.infoValue}>{company.name || '—'}</p>
              </div>
              <div className={styles.infoRow}>
                <p className={styles.infoLabel}>Created</p>
                <p className={styles.infoValue}>{formatDate(company.createdAt)}</p>
              </div>
              <div className={styles.infoRow}>
                <p className={styles.infoLabel}>Stripe Customer ID</p>
                {company.stripeCustomerId ? (
                  <a
                    href={`https://dashboard.stripe.com/customers/${company.stripeCustomerId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`${styles.infoValueMono} ${styles.infoValueLink}`}
                  >
                    {company.stripeCustomerId}
                    <span className="material-symbols-outlined" style={{ fontSize: '13px', marginLeft: '4px', verticalAlign: 'middle' }}>open_in_new</span>
                  </a>
                ) : (
                  <p className={`${styles.infoValueMono} ${styles.infoValueMuted}`}>—</p>
                )}
              </div>
              <div className={styles.infoRow}>
                <p className={styles.infoLabel}>Had Trial</p>
                <p className={styles.infoValue}>{company.hadTrial ? 'Yes' : 'No'}</p>
              </div>
            </div>

            {/* Right column */}
            <div className={styles.infoBlock}>
              <div className={styles.infoRow}>
                <p className={styles.infoLabel}>Status</p>
                <p className={`${styles.infoValue} ${statusClass(company.subscription.status)}`}>
                  {company.subscription.status || '—'}
                </p>
              </div>
              <div className={styles.infoRow}>
                <p className={styles.infoLabel}>Plan</p>
                <p className={styles.infoValue}>{company.subscription.plan || '—'}</p>
              </div>
              <div className={styles.infoRow}>
                <p className={styles.infoLabel}>Period End</p>
                <p className={styles.infoValue}>{formatDate(company.subscription.currentPeriodEnd)}</p>
              </div>
              {company.subscription.cancelAtPeriodEnd && (
                <div className={styles.infoRow}>
                  <p className={styles.infoLabel}>Cancellation</p>
                  <p className={`${styles.infoValue} ${styles.infoValueError}`}>
                    YES — cancels at period end
                  </p>
                </div>
              )}
              {company.subscription.trialEnd && (
                <div className={styles.infoRow}>
                  <p className={styles.infoLabel}>Trial End</p>
                  <p className={styles.infoValue}>{formatDate(company.subscription.trialEnd)}</p>
                </div>
              )}
              <div className={styles.infoRow}>
                <p className={styles.infoLabel}>Limits</p>
                <p className={styles.infoValue}>
                  {company.subscription.limits.equipment} equipment / {company.subscription.limits.users} users
                </p>
              </div>
              {company.subscription.interval && (
                <div className={styles.infoRow}>
                  <p className={styles.infoLabel}>Interval</p>
                  <p className={styles.infoValue}>{company.subscription.interval}</p>
                </div>
              )}
              {company.subscription.stripeSubscriptionId && (
                <div className={styles.infoRow}>
                  <p className={styles.infoLabel}>Stripe Subscription ID</p>
                  <p className={styles.infoValueMono}>{company.subscription.stripeSubscriptionId}</p>
                </div>
              )}
            </div>
          </div>

          {/* Members table */}
          <p className={styles.sectionLabel}>Members ({members.length})</p>
          <div style={{ overflowX: 'auto' }}>
            <table className={styles.memberTable}>
              <thead>
                <tr>
                  <th className={styles.th}>Name</th>
                  <th className={styles.th}>Email</th>
                  <th className={styles.th}>Role</th>
                  <th className={styles.th}>Joined</th>
                </tr>
              </thead>
              <tbody>
                {members.length === 0 ? (
                  <tr>
                    <td className={styles.td} colSpan={4} style={{ color: 'var(--on-surface-variant)' }}>
                      No members
                    </td>
                  </tr>
                ) : (
                  members.map((m) => (
                    <tr key={m.uid} className={styles.tr}>
                      <td className={styles.td}>{m.name || '—'}</td>
                      <td className={styles.td}>{m.email}</td>
                      <td className={styles.td}>{m.role}</td>
                      <td className={styles.td}>{formatDate(m.joinedAt)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'activity' && (
        <div>
          <div className={styles.statGrid}>
            <div className={styles.statCard}>
              <p className={styles.statValue}>{stats.bookings}</p>
              <p className={styles.statLabel}>Bookings</p>
            </div>
            <div className={styles.statCard}>
              <p className={styles.statValue}>{stats.equipment}</p>
              <p className={styles.statLabel}>Equipment</p>
            </div>
            <div className={styles.statCard}>
              <p className={styles.statValue} style={{ fontSize: stats.lastBookingAt ? '24px' : 'var(--font-stat)' }}>
                {stats.lastBookingAt
                  ? formatDate(stats.lastBookingAt)
                  : 'Never'}
              </p>
              <p className={styles.statLabel}>Last Booking</p>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'notes' && (
        <div>
          <p className={styles.sectionLabel}>Internal Notes</p>
          <textarea
            className={styles.notesTextarea}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={handleNotesBlur}
            placeholder="Add internal notes about this customer…"
          />
          <p className={styles.notesHelper}>
            {saving ? 'Saving…' : 'Saved automatically on blur'}
          </p>
        </div>
      )}
    </div>
  )
}
