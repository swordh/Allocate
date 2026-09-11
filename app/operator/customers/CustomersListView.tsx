'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  SEGMENTS,
  SEGMENT_LABELS,
  PLANS,
  PLAN_FILTER_LABELS,
  SORTS,
  SORT_LABELS,
  type CompanyRow,
  type Segment,
  type PlanFilter,
  type Sort,
} from '@/types/operator'
import Icon from '@/components/ui/Icon'
import Glyph from '@/components/ui/Glyph'
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import styles from './customers.module.css'

/** Typing fires a Server Component re-render that does an unpaginated
 *  `companies` scan plus a members read (see page.tsx) — debounce so a
 *  five-character search is one request, not five. */
const SEARCH_DEBOUNCE_MS = 300

export interface TeamMember {
  uid: string
  name: string
  email: string
  role: string
}

export interface SelectedDetail {
  notes: string
  /** Null means the members read failed — render "unavailable", not "no members". */
  team: TeamMember[] | null
}

interface CustomersListViewProps {
  rows: CompanyRow[]
  query: string
  segment: Segment
  plan: PlanFilter | null
  sort: Sort
  totalCount: number
  unmigratedCount: number
  selectedId: string | null
  selectedDetail: SelectedDetail | null
}

interface HrefState {
  segment: Segment
  query: string
  plan: PlanFilter | null
  sort: Sort
  selected: string | null
}

/** Builds a /operator/customers URL from the current filter state plus overrides. */
function href(state: HrefState, overrides: Partial<HrefState> = {}): string {
  const merged = { ...state, ...overrides }
  const params = new URLSearchParams()
  if (merged.segment !== 'all') params.set('segment', merged.segment)
  if (merged.query) params.set('q', merged.query)
  if (merged.plan) params.set('plan', merged.plan)
  if (merged.sort !== 'last_booking') params.set('sort', merged.sort)
  if (merged.selected) params.set('selected', merged.selected)
  const qs = params.toString()
  return qs ? `/operator/customers?${qs}` : '/operator/customers'
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

/** Null means the backfill has not reached this company — never render it as zero. */
function NumOrDash({ value }: { value: number | null }) {
  if (value === null) return <span className={styles.unknown}>—</span>
  return <span className={styles.num}>{value}</span>
}

/** Same singular-aware treatment as the result label (`1 MATCH` / `N MATCHES`). */
function unitLabel(value: number | null, unit: string): string {
  if (value === null) return `— ${unit}S`
  return `${value} ${unit}${value === 1 ? '' : 'S'}`
}

const STATUS_LABELS: Record<string, string> = {
  active: 'ACTIVE',
  trialing: 'TRIALING',
  past_due: 'PAST DUE',
  canceled: 'CANCELED',
  unknown: 'UNKNOWN',
}

// TRIALING (#9fb3c8) and CANCELED/UNKNOWN (#6f7078) have no matching token in
// app/globals.css — used verbatim from the design, flagged in the PR report.
function statusColorClass(status: string): string {
  switch (status) {
    case 'active':   return styles.statusActive
    case 'trialing': return styles.statusTrialing
    case 'past_due': return styles.statusPastDue
    case 'canceled': return styles.statusCanceled
    default:         return styles.statusCanceled
  }
}

function StatusTag({ status }: { status: string }) {
  return (
    <span className={`${styles.status} ${statusColorClass(status)}`}>
      <span className={styles.statusDot} />
      {STATUS_LABELS[status] ?? status.toUpperCase()}
    </span>
  )
}

function planCap(
  limits: { equipment: number | null; users: number | null },
  kind: 'equipment' | 'users',
): number | null {
  return limits[kind]
}

/**
 * `cap` is null whenever `subscription.limits` is missing on the company
 * doc — a real state (see types/operator.ts), not a data error. Rendering
 * that as "0" would fabricate a zero-unit plan and make an unknown cap
 * visually identical to a real over-limit bar, so a null (or non-positive,
 * belt-and-braces against a future bad write) cap gets no bar at all —
 * same "unknown, not zero" treatment as the null `stats` fields.
 */
function LimitBar({
  label,
  value,
  cap,
}: {
  label: string
  value: number | null
  cap: number | null
}) {
  const displayValue = value === null ? '—' : value

  if (cap === null || cap <= 0) {
    return (
      <div className={styles.limitRow}>
        <span className={styles.limitLabel}>
          {displayValue} / — {label}
        </span>
      </div>
    )
  }

  const over = value !== null && value > cap
  const pct = value === null ? 0 : Math.min(100, Math.round((value / cap) * 100))
  return (
    <div className={styles.limitRow}>
      <span className={over ? styles.limitLabelOver : styles.limitLabel}>
        {displayValue} / {cap} {label}
        {over ? ' · OVER LIMIT' : ''}
      </span>
      <div className={styles.limitTrack}>
        <div
          className={over ? styles.limitFillOver : styles.limitFill}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export default function CustomersListView({
  rows,
  query,
  segment,
  plan,
  sort,
  totalCount,
  unmigratedCount,
  selectedId,
  selectedDetail,
}: CustomersListViewProps) {
  const router = useRouter()
  const state: HrefState = { segment, query, plan, sort, selected: selectedId }
  const filteredView = Boolean(query || segment !== 'all' || plan)
  const resultCount = rows.length
  const resultLabel = filteredView
    ? `${resultCount} ${resultCount === 1 ? 'MATCH' : 'MATCHES'}`
    : `${resultCount} ${resultCount === 1 ? 'CUSTOMER' : 'CUSTOMERS'}`

  const selectedRow = rows.find((r) => r.id === selectedId) ?? null

  const debouncedNavigate = useDebouncedCallback((value: string) => {
    router.replace(href(state, { query: value }))
  }, SEARCH_DEBOUNCE_MS)

  // Input stays uncontrolled (defaultValue) — only the navigation is
  // debounced, not the field's own value, so typing never feels laggy.
  function handleSearch(e: React.ChangeEvent<HTMLInputElement>) {
    debouncedNavigate(e.target.value)
  }

  return (
    <div className={styles.screen}>
      {unmigratedCount > 0 && (
        <div className={styles.banner}>
          {unmigratedCount} of {totalCount} companies have no stats yet and are excluded from the{' '}
          <strong>{SEGMENT_LABELS.no_bookings_30d}</strong> segment. Run{' '}
          <code>tools/backfill_company_stats.js --project=&lt;id&gt; --yes</code> to populate them.
        </div>
      )}

      {/* ---------- Desktop: three independently-scrolling columns ---------- */}
      <div className={styles.desktop}>
        <aside className={styles.rail}>
          <div className={styles.railGroup}>
            <span className={styles.railHeading}>SEGMENTS</span>
            {SEGMENTS.map((s) => (
              <Link
                key={s}
                href={href(state, { segment: s })}
                className={s === segment ? `${styles.railRow} ${styles.railRowActive}` : styles.railRow}
              >
                <span className={styles.railRowLabel}>{SEGMENT_LABELS[s]}</span>
                {s === 'all' && <span className={styles.railRowCount}>{totalCount}</span>}
              </Link>
            ))}
          </div>

          <div className={styles.railGroup}>
            <span className={styles.railHeading}>PLAN</span>
            {PLANS.map((p) => (
              <Link
                key={p}
                href={href(state, { plan: plan === p ? null : p })}
                className={p === plan ? `${styles.railRow} ${styles.railRowActive}` : styles.railRow}
              >
                <span className={styles.railRowLabel}>{PLAN_FILTER_LABELS[p]}</span>
              </Link>
            ))}
          </div>

          <div className={styles.railGroup}>
            <span className={styles.railHeading}>SORT</span>
            <div className={styles.sortList}>
              {SORTS.map((s) => (
                <Link
                  key={s}
                  href={href(state, { sort: s })}
                  className={s === sort ? styles.sortLinkActive : styles.sortLink}
                >
                  {SORT_LABELS[s]}
                </Link>
              ))}
            </div>
          </div>
        </aside>

        <div className={styles.middle}>
          <div className={styles.searchRow}>
            <div className={styles.searchShell}>
              <Icon name="search" size={14} className={styles.searchIcon} />
              <input
                className={styles.searchInput}
                type="search"
                placeholder="Search companies"
                defaultValue={query}
                onChange={handleSearch}
              />
            </div>
            <span className={styles.resultLabel}>{resultLabel}</span>
          </div>

          <div className={styles.listScroll}>
            <div className={styles.listHeader}>
              <span className={styles.listHeaderCompany}>COMPANY</span>
              <span>STATUS</span>
              <span>PLAN</span>
              <span className={styles.listHeaderTeam}>TEAM</span>
            </div>

            {rows.length === 0 ? (
              <div className={styles.emptyState}>NO CUSTOMERS MATCH THIS FILTER</div>
            ) : (
              rows.map((row) => {
                const isSelected = row.id === selectedId
                return (
                  <Link
                    key={row.id}
                    href={href(state, { selected: row.id })}
                    className={isSelected ? `${styles.row} ${styles.rowSelected}` : styles.row}
                  >
                    <span className={isSelected ? styles.rowNameSelected : styles.rowName}>
                      {row.name || '(unnamed)'}
                    </span>
                    <StatusTag status={row.subscriptionStatus} />
                    <span className={styles.rowPlan}>{row.subscriptionPlan || '—'}</span>
                    <span className={styles.rowTeam}>
                      <NumOrDash value={row.memberCount} />
                    </span>
                  </Link>
                )
              })
            )}
          </div>
        </div>

        <aside className={styles.detail}>
          {selectedRow ? (
            <>
              <div className={styles.detailHeader}>
                <span className={styles.detailName}>{selectedRow.name || '(unnamed)'}</span>
                <div className={styles.detailMeta}>
                  <StatusTag status={selectedRow.subscriptionStatus} />
                  <span className={styles.metaDot}>·</span>
                  <span className={styles.metaMuted}>{selectedRow.subscriptionPlan || '—'}</span>
                  <span className={styles.metaDot}>·</span>
                  <span className={styles.metaMuted}>
                    RENEWS {formatDate(selectedRow.currentPeriodEnd)}
                  </span>
                </div>
                <span className={styles.stripeId}>{selectedRow.stripeCustomerId || '—'}</span>
                <div className={styles.detailActions}>
                  <Link href={`/operator/customers/${selectedRow.id}`} className={styles.btnPrimary}>
                    OPEN CUSTOMER
                  </Link>
                  {selectedRow.stripeCustomerId && (
                    <a
                      href={`https://dashboard.stripe.com/customers/${selectedRow.stripeCustomerId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.btnOutline}
                    >
                      STRIPE
                    </a>
                  )}
                </div>
              </div>

              <div className={styles.statGrid}>
                <div className={styles.statCell}>
                  <span className={styles.statLabel}>MEMBERS</span>
                  <span className={styles.statValue}><NumOrDash value={selectedRow.memberCount} /></span>
                </div>
                <div className={styles.statCell}>
                  <span className={styles.statLabel}>BOOKINGS</span>
                  <span className={styles.statValue}><NumOrDash value={selectedRow.bookingsCreated} /></span>
                </div>
                <div className={styles.statCell}>
                  <span className={styles.statLabel}>EQUIPMENT</span>
                  <span className={styles.statValue}><NumOrDash value={selectedRow.equipmentCount} /></span>
                </div>
                <div className={styles.statCell}>
                  <span className={styles.statLabel}>LAST BOOKING</span>
                  <span className={styles.statValue}>{formatDate(selectedRow.lastBookingAt)}</span>
                </div>
              </div>

              <div className={styles.limitsSection}>
                <span className={styles.sectionHeading}>PLAN LIMITS</span>
                <LimitBar
                  label="EQUIPMENT"
                  value={selectedRow.equipmentCount}
                  cap={planCap(selectedRow.limits, 'equipment')}
                />
                <LimitBar
                  label="USERS"
                  value={selectedRow.memberCount}
                  cap={planCap(selectedRow.limits, 'users')}
                />
              </div>

              <div className={styles.teamSection}>
                <span className={styles.sectionHeading}>
                  TEAM · {selectedRow.memberCount === null ? '—' : selectedRow.memberCount}
                </span>
                {selectedDetail?.team === null ? (
                  <span className={styles.metaMuted}>Team data unavailable</span>
                ) : selectedDetail?.team.length ? (
                  selectedDetail.team.map((m) => (
                    <div key={m.uid} className={styles.teamRow}>
                      <div className={styles.teamInfo}>
                        <div className={styles.teamName}>{m.name || '—'}</div>
                        <div className={styles.teamEmail}>{m.email}</div>
                      </div>
                      <span className={styles.teamRole}>{m.role.toUpperCase()}</span>
                    </div>
                  ))
                ) : (
                  <span className={styles.metaMuted}>No members</span>
                )}
              </div>

              <div className={styles.notesSection}>
                <span className={styles.sectionHeading}>INTERNAL NOTES</span>
                <div className={styles.notesBox}>
                  {selectedDetail?.notes || '—'}
                </div>
              </div>
            </>
          ) : (
            <div className={styles.emptyState}>NO CUSTOMER SELECTED</div>
          )}
        </aside>
      </div>

      {/* ---------- Mobile: chip filters + full-width rows, no detail panel ---------- */}
      <div className={styles.mobile}>
        <div className={styles.mobileSearchShell}>
          <Icon name="search" size={15} className={styles.searchIcon} />
          <input
            className={styles.mobileSearchInput}
            type="search"
            placeholder="Search companies"
            defaultValue={query}
            onChange={handleSearch}
          />
        </div>

        <div className={styles.mobileChipRow}>
          {SEGMENTS.map((s) => (
            <Link
              key={s}
              href={href(state, { segment: s })}
              className={s === segment ? `${styles.mobileChip} ${styles.mobileChipActive}` : styles.mobileChip}
            >
              {SEGMENT_LABELS[s]}
              {s === 'all' && <span className={styles.railRowCount}>{totalCount}</span>}
            </Link>
          ))}
        </div>

        <div className={styles.mobilePlanRow}>
          <div className={styles.mobilePlanChips}>
            {PLANS.map((p) => (
              <Link
                key={p}
                href={href(state, { plan: plan === p ? null : p })}
                className={p === plan ? `${styles.mobilePlanChip} ${styles.mobileChipActive}` : styles.mobilePlanChip}
              >
                {PLAN_FILTER_LABELS[p].toUpperCase()}
              </Link>
            ))}
          </div>
          <span className={styles.resultLabel}>{resultLabel}</span>
        </div>

        <div className={styles.mobileList}>
          {rows.length === 0 ? (
            <div className={styles.emptyState}>NO CUSTOMERS MATCH THIS FILTER</div>
          ) : (
            rows.map((row) => (
              <Link key={row.id} href={`/operator/customers/${row.id}`} className={styles.mobileRow}>
                <div className={styles.mobileRowInfo}>
                  <span className={styles.mobileRowName}>{row.name || '(unnamed)'}</span>
                  <div className={styles.mobileRowMeta}>
                    <StatusTag status={row.subscriptionStatus} />
                    <span className={styles.metaDot}>·</span>
                    <span className={styles.metaMuted}>{row.subscriptionPlan || '—'}</span>
                    <span className={styles.metaDot}>·</span>
                    <span className={styles.metaMuted}>{unitLabel(row.memberCount, 'USER')}</span>
                  </div>
                </div>
                <Glyph char="›" />
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
