'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { addOperatorNote } from './actions'
import type { FeedEntry } from './activity'
import Icon from '@/components/ui/Icon'
import styles from './detail.module.css'

interface Subscription {
  status: string
  plan: string
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  trialEnd: string | null
  interval: string | null
  limits: { equipment: number | null; users: number | null }
  stripeSubscriptionId: string | null
}

interface Company {
  id: string
  name: string
  createdAt: string
  stripeCustomerId: string
  hadTrial: boolean
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
  /** null when the count query failed — render "—", never 0. */
  bookingsTotal: number | null
  bookings30d: number | null
  equipmentCount: number | null
  lastBooking: { at: string | null; projectName: string | null } | null
  /** null: no Stripe subscription, no active price, subscription isn't
   *  active/trialing, or the price fetch failed. */
  mrr: number | null
}

export interface OperatorNote {
  id: string
  text: string
  createdAt: string
  createdBy: string
}

/** Which optional reads on the server failed — each degrades its own
 *  section instead of the page. Never conflate "unavailable" with "empty":
 *  they render different copy. */
interface Unavailable {
  team: boolean
  bookingHistory: boolean
  notes: boolean
  planEvents: boolean
}

interface CustomerDetailViewProps {
  company: Company
  members: Member[]
  stats: Stats
  notes: OperatorNote[]
  /** True when the notes read hit its cap — older notes exist but aren't shown. */
  notesCapped: boolean
  feed: FeedEntry[]
  paymentsUnavailable: boolean
  unavailable: Unavailable
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).toUpperCase()
}

function formatMonthYear(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }).toUpperCase()
}

function formatFeedDate(atIso: string): string {
  const d = new Date(atIso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return `TODAY ${time}`
  return `${formatDate(atIso)}`
}

function monthsSince(iso: string): number {
  const start = new Date(iso)
  const now = new Date()
  return Math.max(0, (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()))
}

function statusColor(status: string): string {
  switch (status) {
    case 'active':   return styles.statusActive
    case 'trialing': return styles.statusTrialing
    case 'past_due': return styles.statusPastDue
    default:         return styles.statusMuted
  }
}

interface Metric { label: string; value: string; sub: string }

function buildMetrics(company: Company, members: Member[], stats: Stats, teamUnavailable: boolean, bookingHistoryUnavailable: boolean): Metric[] {
  const { limits } = company.subscription
  return [
    {
      label: 'MEMBERS',
      value: teamUnavailable ? '—' : String(members.length),
      sub: teamUnavailable ? 'UNAVAILABLE' : limits.users != null ? `OF ${limits.users} INCLUDED` : '—',
    },
    {
      label: 'BOOKINGS',
      value: stats.bookingsTotal != null ? String(stats.bookingsTotal) : '—',
      sub: stats.bookings30d != null ? `${stats.bookings30d} LAST 30 DAYS` : '—',
    },
    {
      label: 'EQUIPMENT',
      value: stats.equipmentCount != null ? String(stats.equipmentCount) : '—',
      sub: limits.equipment != null ? `OF ${limits.equipment} INCLUDED` : '—',
    },
    {
      label: 'LAST BOOKING',
      // "Never" is a claim — only safe to render once we know the booking
      // read actually succeeded. Otherwise this would lie about a company
      // that has bookings we simply failed to read this time.
      value: bookingHistoryUnavailable ? '—' : stats.lastBooking?.at ? formatDate(stats.lastBooking.at) : 'Never',
      sub: bookingHistoryUnavailable ? 'UNAVAILABLE' : stats.lastBooking?.projectName ? stats.lastBooking.projectName.toUpperCase() : '—',
    },
    {
      label: 'MRR',
      value: stats.mrr != null ? `${stats.mrr.toLocaleString('sv-SE')} kr` : '—',
      // Qualified here, not on the label: this is Stripe's list price on the
      // active item, before any discount/coupon — never the customer's
      // actual invoiced total.
      sub: stats.mrr == null
        ? '—'
        : company.subscription.interval === 'year'
          ? 'LIST PRICE · ANNUAL'
          : company.subscription.interval === 'month'
            ? 'LIST PRICE · MONTHLY'
            : 'LIST PRICE',
    },
    {
      label: 'CUSTOMER SINCE',
      value: company.createdAt ? formatMonthYear(company.createdAt) : '—',
      sub: company.createdAt ? `${monthsSince(company.createdAt)} MONTHS` : '—',
    },
  ]
}

interface SubRow { label: string; value: string; className?: string }

function buildSubRows(company: Company): SubRow[] {
  const { subscription } = company
  const rows: SubRow[] = [
    { label: 'Status', value: subscription.status || '—', className: statusColor(subscription.status) },
    { label: 'Plan', value: subscription.plan || '—' },
    { label: 'Billing cycle', value: subscription.interval === 'year' ? 'Annual' : subscription.interval === 'month' ? 'Monthly' : '—' },
    { label: 'Renews', value: formatDate(subscription.currentPeriodEnd) },
  ]
  if (subscription.cancelAtPeriodEnd) {
    rows.push({ label: 'Cancellation', value: 'Cancels at period end', className: styles.statusPastDue })
  }
  if (subscription.trialEnd) {
    rows.push({ label: 'Trial ends', value: formatDate(subscription.trialEnd) })
  }
  rows.push({ label: 'Stripe customer', value: subscription.stripeSubscriptionId || '—' })
  return rows
}

function MetricGrid({ metrics }: { metrics: Metric[] }) {
  return (
    <div className={styles.metricGrid}>
      {metrics.map((m) => (
        <div key={m.label} className={styles.metricCell}>
          <span className={styles.metricLabel}>{m.label}</span>
          <span className={styles.metricValue}>{m.value}</span>
          <span className={styles.metricSub}>{m.sub}</span>
        </div>
      ))}
    </div>
  )
}

function SubscriptionSection({ rows }: { rows: SubRow[] }) {
  return (
    <div className={styles.subSection}>
      <span className={styles.sectionLabel}>SUBSCRIPTION</span>
      {rows.map((r) => (
        <div key={r.label} className={styles.subRow}>
          <span className={styles.subRowLabel}>{r.label}</span>
          <span className={r.className ? `${styles.subRowValue} ${r.className}` : styles.subRowValue}>{r.value}</span>
        </div>
      ))}
    </div>
  )
}

function LimitBar({ label, value, cap }: { label: string; value: number | null; cap: number | null }) {
  const over = cap != null && value != null && value > cap
  const pct = cap && cap > 0 && value != null ? Math.min(100, Math.round((value / cap) * 100)) : 0
  return (
    <div className={styles.limitRow}>
      <span className={over ? styles.limitLabelOver : styles.limitLabel}>
        {value ?? '—'} / {cap ?? '—'} {label}{over ? ' · OVER LIMIT' : ''}
      </span>
      <div className={styles.limitTrack}>
        <div className={over ? styles.limitFillOver : styles.limitFill} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function UsageSection({ company, members, stats, teamUnavailable }: {
  company: Company; members: Member[]; stats: Stats; teamUnavailable: boolean
}) {
  return (
    <div className={styles.usageSection}>
      <span className={styles.sectionLabel}>USAGE AGAINST PLAN</span>
      <LimitBar label="EQUIPMENT" value={stats.equipmentCount} cap={company.subscription.limits.equipment} />
      <LimitBar label="USERS" value={teamUnavailable ? null : members.length} cap={company.subscription.limits.users} />
    </div>
  )
}

function ActivitySection({ feed, paymentsUnavailable, noBilling, bookingHistoryUnavailable, planEventsUnavailable }: {
  feed: FeedEntry[]
  paymentsUnavailable: boolean
  noBilling: boolean
  bookingHistoryUnavailable: boolean
  planEventsUnavailable: boolean
}) {
  return (
    <div className={styles.activitySection}>
      <span className={styles.sectionLabel}>RECENT ACTIVITY</span>
      {feed.length === 0 && <span className={styles.metaMuted}>No activity recorded</span>}
      {feed.map((entry, i) => (
        <div key={i} className={styles.activityRow}>
          <span className={styles.activityDate}>{formatFeedDate(entry.atIso)}</span>
          <span className={styles.activityText}>{entry.text}</span>
        </div>
      ))}
      {paymentsUnavailable && (
        <div className={styles.activityMarker}>Payments unavailable right now — Stripe could not be reached.</div>
      )}
      {!paymentsUnavailable && noBilling && (
        <div className={styles.activityMarker}>No billing history.</div>
      )}
      {bookingHistoryUnavailable && (
        <div className={styles.activityMarker}>Booking history unavailable right now — some entries above may be missing.</div>
      )}
      {planEventsUnavailable && (
        <div className={styles.activityMarker}>Plan and status change history unavailable right now.</div>
      )}
      {/* Deliberately undated: this feature shipped at different times per
          environment (alpha/beta/prod), so a single hardcoded date would be
          false in at least two of the three. An honest vague statement
          beats a precise false one. */}
      <div className={styles.activityMarker}>
        Plan and status changes are recorded from when this tracking shipped. Changes made before that were not logged and cannot be shown here.
      </div>
    </div>
  )
}

function TeamSection({ members, teamUnavailable }: { members: Member[]; teamUnavailable: boolean }) {
  return (
    <div className={styles.teamSection}>
      <div className={styles.teamHeadingRow}>
        <span className={styles.sectionLabel}>TEAM MEMBERS · {teamUnavailable ? '—' : members.length}</span>
        <span className={styles.teamHeadingRule} />
      </div>
      <div className={styles.teamHeader}>
        <span>NAME</span><span>EMAIL</span><span>ROLE</span><span className={styles.teamHeaderJoined}>JOINED</span>
      </div>
      {teamUnavailable ? (
        <div className={styles.metaMuted}>Team data unavailable</div>
      ) : members.length === 0 ? (
        <div className={styles.metaMuted}>No members</div>
      ) : (
        members.map((m) => (
          <div key={m.uid} className={styles.teamRow}>
            <span className={styles.teamName}>{m.name || '—'}</span>
            <span className={styles.teamEmail}>{m.email}</span>
            <span className={styles.teamRole}>{m.role.toUpperCase()}</span>
            <span className={styles.teamJoined}>{formatDate(m.joinedAt)}</span>
          </div>
        ))
      )}
    </div>
  )
}

/** Shared note-composer state — lifted to the parent (see CustomerDetailView)
 *  so the desktop aside and mobile inline trees, which both mount this
 *  panel simultaneously (one hidden via CSS depending on viewport width),
 *  always read the same draft. Otherwise a half-written note vanishes the
 *  moment the viewport crosses the 768px breakpoint. */
interface NotesPanelProps {
  companyId: string
  notes: OperatorNote[]
  notesCapped: boolean
  notesUnavailable: boolean
  variant: 'aside' | 'inline'
  draft: string
  onDraftChange: (value: string) => void
  saved: boolean
  pending: boolean
  onSave: () => void
}

function NotesPanel({
  notes,
  notesCapped,
  notesUnavailable,
  variant,
  draft,
  onDraftChange,
  saved,
  pending,
  onSave,
}: NotesPanelProps) {
  const hasDraft = draft.trim().length > 0
  const saveState = pending ? 'SAVING…' : saved ? 'SAVED' : hasDraft ? 'UNSAVED CHANGES' : 'ALL CHANGES SAVED'

  return (
    <div className={variant === 'aside' ? styles.notesAside : styles.notesInline}>
      <div className={styles.notesHeader}>
        <span className={styles.sectionLabel}>INTERNAL NOTES</span>
        <span className={styles.saveState}>{saveState}</span>
      </div>
      <div className={styles.notesComposer}>
        <textarea
          className={styles.notesTextarea}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder="Add a note…"
        />
        <div className={styles.notesComposerFooter}>
          <span className={styles.notesHelper}>Visible to operators only</span>
          <button
            type="button"
            className={hasDraft ? styles.saveNoteActive : styles.saveNote}
            onClick={onSave}
            disabled={!hasDraft || pending}
          >
            SAVE NOTE
          </button>
        </div>
      </div>
      <div className={styles.notesList}>
        {notesUnavailable ? (
          <span className={styles.metaMuted}>Notes could not be loaded right now</span>
        ) : notes.length === 0 ? (
          <span className={styles.metaMuted}>No notes yet</span>
        ) : (
          notes.map((n) => (
            <div key={n.id} className={styles.noteRow}>
              <div className={styles.noteByline}>
                <span className={styles.noteAuthor}>{n.createdBy}</span>
                <span>{formatFeedDate(n.createdAt)}</span>
              </div>
              <span className={styles.noteText}>{n.text}</span>
            </div>
          ))
        )}
        {notesCapped && (
          <span className={styles.notesCappedNotice}>Showing the most recent notes only — older notes exist but aren&apos;t shown.</span>
        )}
      </div>
    </div>
  )
}

export default function CustomerDetailView({
  company,
  members,
  stats,
  notes,
  notesCapped,
  feed,
  paymentsUnavailable,
  unavailable,
}: CustomerDetailViewProps) {
  const [copied, setCopied] = useState(false)
  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState(false)
  const [pending, startTransition] = useTransition()

  const metrics = buildMetrics(company, members, stats, unavailable.team, unavailable.bookingHistory)
  const subRows = buildSubRows(company)
  const noBilling = !company.stripeCustomerId

  function handleCopy() {
    if (!company.stripeCustomerId) return
    navigator.clipboard.writeText(company.stripeCustomerId).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  function handleDraftChange(value: string) {
    setDraft(value)
    setSaved(false)
  }

  function handleSaveNote() {
    if (!draft.trim()) return
    startTransition(async () => {
      const result = await addOperatorNote(company.id, draft)
      if (!result.error) {
        setDraft('')
        setSaved(true)
      }
    })
  }

  const notesPanelSharedProps = {
    companyId: company.id,
    notes,
    notesCapped,
    notesUnavailable: unavailable.notes,
    draft,
    onDraftChange: handleDraftChange,
    saved,
    pending,
    onSave: handleSaveNote,
  }

  const header = (
    <div className={styles.header}>
      <Link href="/operator/customers" className={styles.backLink}>← ALL CUSTOMERS</Link>
      <div className={styles.headerRow}>
        <div className={styles.headerLeft}>
          <span className={styles.title}>{company.name || '(unnamed)'}</span>
          <div className={styles.metaRow}>
            <span className={`${styles.statusTag} ${statusColor(company.subscription.status)}`}>
              <span className={styles.statusDot} />
              {(company.subscription.status || 'unknown').toUpperCase()}
            </span>
            <span className={styles.metaDot}>·</span>
            <span className={styles.metaMuted}>
              {company.subscription.plan || '—'} · {company.subscription.interval === 'year' ? 'Annual' : company.subscription.interval === 'month' ? 'Monthly' : '—'}
            </span>
            <span className={styles.metaDot}>·</span>
            <span className={styles.metaMuted}>SIGNED UP {formatDate(company.createdAt)}</span>
            <span className={styles.metaDot}>·</span>
            <span className={styles.metaFaint}>{company.stripeCustomerId || 'no stripe customer'}</span>
          </div>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={copied ? styles.copyBtnCopied : styles.copyBtn}
            onClick={handleCopy}
            disabled={!company.stripeCustomerId}
          >
            {copied ? 'COPIED' : 'COPY STRIPE ID'}
          </button>
          {company.stripeCustomerId ? (
            <a
              href={`https://dashboard.stripe.com/customers/${company.stripeCustomerId}`}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.stripeBtn}
            >
              OPEN IN STRIPE <Icon name="external-link" size={13} />
            </a>
          ) : (
            <span className={styles.stripeBtnDisabled}>OPEN IN STRIPE</span>
          )}
        </div>
      </div>
    </div>
  )

  return (
    // legacyPad dropped here per Part 4 — this screen owns its own spacing now.
    <div className={styles.screen}>
      <div className={styles.main}>
        {header}
        <MetricGrid metrics={metrics} />

        {/* ---- Desktop: two-column band, notes in a fixed 392px aside ---- */}
        <div className={styles.desktopOnly}>
          <div className={styles.band}>
            <SubscriptionSection rows={subRows} />
            <div className={styles.usageActivityCol}>
              <UsageSection company={company} members={members} stats={stats} teamUnavailable={unavailable.team} />
              <ActivitySection
                feed={feed}
                paymentsUnavailable={paymentsUnavailable}
                noBilling={noBilling}
                bookingHistoryUnavailable={unavailable.bookingHistory}
                planEventsUnavailable={unavailable.planEvents}
              />
            </div>
          </div>
          <TeamSection members={members} teamUnavailable={unavailable.team} />
        </div>

        {/* ---- Mobile: USAGE -> SUBSCRIPTION -> ACTIVITY -> TEAM -> NOTES ---- */}
        <div className={styles.mobileOnly}>
          <UsageSection company={company} members={members} stats={stats} teamUnavailable={unavailable.team} />
          <SubscriptionSection rows={subRows} />
          <ActivitySection
            feed={feed}
            paymentsUnavailable={paymentsUnavailable}
            noBilling={noBilling}
            bookingHistoryUnavailable={unavailable.bookingHistory}
            planEventsUnavailable={unavailable.planEvents}
          />
          <TeamSection members={members} teamUnavailable={unavailable.team} />
          <NotesPanel {...notesPanelSharedProps} variant="inline" />
        </div>
      </div>

      <aside className={styles.desktopOnlyAside}>
        <NotesPanel {...notesPanelSharedProps} variant="aside" />
      </aside>
    </div>
  )
}
