'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Icon from '@/components/ui/Icon'
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import {
  FEEDBACK_STATUS_FILTERS,
  FEEDBACK_TYPE_FILTERS,
  FEEDBACK_SORTS,
  type OperatorFeedback,
  type FeedbackStatusFilter,
  type FeedbackTypeFilter,
  type FeedbackSort,
  type FeedbackStatus,
  type FeedbackPriority,
  type StoredFeedbackStatus,
  type StoredFeedbackPriority,
  type StoredFeedbackType,
  type FeedbackTimelineEntry,
} from '@/types/operator'
import { updateFeedbackStatus, updateFeedbackPriority, addFeedbackNote } from './actions'
import styles from './feedback.module.css'

const SEARCH_DEBOUNCE_MS = 300

interface FeedbackListViewProps {
  items: OperatorFeedback[]
  allCount: number
  statusCounts: Record<string, number>
  typeCounts: Record<string, number>
  query: string
  status: FeedbackStatusFilter
  type: FeedbackTypeFilter
  sort: FeedbackSort
  selectedId: string | null
  selectedItem: OperatorFeedback | null
  /** Plain notes only, newest first — see FeedbackListView's page.tsx for why
   *  events are excluded here (that's screen 24's interleaved thread). */
  selectedNotes: FeedbackTimelineEntry[]
}

interface HrefState {
  status: FeedbackStatusFilter
  type: FeedbackTypeFilter
  sort: FeedbackSort
  query: string
  selected: string | null
}

function href(state: HrefState, overrides: Partial<HrefState> = {}): string {
  const merged = { ...state, ...overrides }
  const params = new URLSearchParams()
  if (merged.status !== 'all') params.set('status', merged.status)
  if (merged.type !== 'all') params.set('type', merged.type)
  if (merged.sort !== 'newest') params.set('sort', merged.sort)
  if (merged.query) params.set('q', merged.query)
  if (merged.selected) params.set('selected', merged.selected)
  const qs = params.toString()
  return qs ? `/operator/feedback?${qs}` : '/operator/feedback'
}

const STATUS_FILTER_LABELS: Record<FeedbackStatusFilter, string> = {
  all: 'All feedback',
  open: 'Open',
  in_progress: 'In progress',
  done: 'Done',
  wont_fix: 'No action',
}

const TYPE_FILTER_LABELS: Record<FeedbackTypeFilter, string> = {
  all: 'All types',
  feature_request: 'Feature requests',
  bug_report: 'Bug reports',
  support: 'Support',
}

const SORT_LABELS: Record<FeedbackSort, string> = {
  newest: 'Newest first',
  priority: 'Priority',
  company: 'Company',
}

// 'unknown' (see types/operator.ts) is never set by any writer — it only
// ever appears when a document is missing the field — so it gets its own
// label/colour rather than quietly inheriting SUPPORT/NO ACTION/LOW's
// styling, which would look like a normal ticket instead of a corrupt one.
// Keyed by the Stored* types since these render whatever a document
// actually holds, not what a caller may set.
const STATUS_BTN_LABELS: Record<StoredFeedbackStatus, string> = {
  open: 'OPEN',
  in_progress: 'IN PROGRESS',
  done: 'DONE',
  wont_fix: 'NO ACTION',
  unknown: 'UNKNOWN',
}

const PRIORITY_BTN_LABELS: Record<StoredFeedbackPriority, string> = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  unknown: 'UNKNOWN',
}

const TYPE_LABELS: Record<StoredFeedbackType, string> = {
  bug_report: 'BUG',
  feature_request: 'FEATURE',
  support: 'SUPPORT',
  unknown: 'UNKNOWN',
}

function typeStripeClass(type: StoredFeedbackType): string {
  if (type === 'bug_report') return styles.stripeBug
  if (type === 'feature_request') return styles.stripeFeature
  if (type === 'support') return styles.stripeSupport
  return styles.stripeUnknown
}

function typeBadgeClass(type: StoredFeedbackType): string {
  if (type === 'bug_report') return styles.typeBadgeBug
  if (type === 'feature_request') return styles.typeBadgeFeature
  if (type === 'support') return styles.typeBadgeSupport
  return styles.typeBadgeUnknown
}

function statusClass(status: StoredFeedbackStatus): string {
  switch (status) {
    case 'open': return styles.statusOpen
    case 'in_progress': return styles.statusInProgress
    case 'done': return styles.statusDone
    case 'wont_fix': return styles.statusNoAction
    default: return styles.typeUnknown
  }
}

function priorityClass(priority: StoredFeedbackPriority): string {
  switch (priority) {
    case 'high': return styles.priorityHigh
    case 'medium': return styles.priorityMedium
    case 'low': return styles.priorityLow
    default: return styles.typeUnknown
  }
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

function formatShortDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]}`
}

export function formatFullDateTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${formatShortDate(iso)} ${d.getFullYear()} · ${hh}:${mm}`
}

function SetterButton({
  label,
  active,
  danger,
  disabled,
  onClick,
}: {
  label: string
  active: boolean
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  const cls = active
    ? danger
      ? `${styles.setterBtn} ${styles.setterBtnDanger}`
      : `${styles.setterBtn} ${styles.setterBtnOn}`
    : styles.setterBtn
  return (
    <button type="button" className={cls} onClick={onClick} disabled={disabled || active}>
      {label}
    </button>
  )
}

export default function FeedbackListView({
  items,
  statusCounts,
  typeCounts,
  query,
  status,
  type,
  sort,
  selectedId,
  selectedItem,
  selectedNotes,
}: FeedbackListViewProps) {
  const router = useRouter()
  const state: HrefState = { status, type, sort, query, selected: selectedId }
  const resultLabel = `${items.length} ${items.length === 1 ? 'ITEM' : 'ITEMS'}`

  const [draft, setDraft] = useState('')
  const [pending, startTransition] = useTransition()

  const debouncedNavigate = useDebouncedCallback((value: string) => {
    router.replace(href(state, { query: value }))
  }, SEARCH_DEBOUNCE_MS)

  function handleSearch(e: React.ChangeEvent<HTMLInputElement>) {
    debouncedNavigate(e.target.value)
  }

  function handleStatusSet(next: FeedbackStatus) {
    if (!selectedItem || selectedItem.status === next) return
    startTransition(async () => {
      await updateFeedbackStatus(selectedItem.id, next)
    })
  }

  function handlePrioritySet(next: FeedbackPriority) {
    if (!selectedItem || selectedItem.priority === next) return
    startTransition(async () => {
      await updateFeedbackPriority(selectedItem.id, next)
    })
  }

  function handleAddNote() {
    if (!selectedItem || !draft.trim()) return
    const id = selectedItem.id
    const text = draft
    startTransition(async () => {
      const result = await addFeedbackNote(id, text)
      if (!result.error) setDraft('')
    })
  }

  const hasDraft = draft.trim().length > 0

  const railStatus = (
    <div className={styles.railGroup}>
      <span className={styles.railHeading}>STATUS</span>
      {FEEDBACK_STATUS_FILTERS.map((s) => (
        <Link
          key={s}
          href={href(state, { status: s })}
          className={s === status ? `${styles.railRow} ${styles.railRowActive}` : styles.railRow}
        >
          <span className={styles.railRowLabel}>{STATUS_FILTER_LABELS[s]}</span>
          <span className={styles.railRowCount}>{statusCounts[s] ?? 0}</span>
        </Link>
      ))}
    </div>
  )

  const railType = (
    <div className={styles.railGroup}>
      <span className={styles.railHeading}>TYPE</span>
      {FEEDBACK_TYPE_FILTERS.map((t) => (
        <Link
          key={t}
          href={href(state, { type: t })}
          className={t === type ? `${styles.railRow} ${styles.railRowActive}` : styles.railRow}
        >
          <span className={styles.railRowLabel}>{TYPE_FILTER_LABELS[t]}</span>
          <span className={styles.railRowCount}>{typeCounts[t] ?? 0}</span>
        </Link>
      ))}
    </div>
  )

  return (
    <div className={styles.screen}>
      {/* ---------- Desktop: three independently-scrolling columns ---------- */}
      <div className={styles.desktop}>
        <aside className={styles.rail}>
          {railStatus}
          {railType}
          <div className={styles.railGroup}>
            <span className={styles.railHeading}>SORT</span>
            <div className={styles.sortList}>
              {FEEDBACK_SORTS.map((s) => (
                <Link key={s} href={href(state, { sort: s })} className={s === sort ? styles.sortLinkActive : styles.sortLink}>
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
                placeholder="Search titles, companies, users"
                defaultValue={query}
                onChange={handleSearch}
              />
            </div>
            <span className={styles.resultLabel}>{resultLabel}</span>
          </div>

          <div className={styles.listScroll}>
            <div className={styles.listHeader}>
              <span className={styles.listHeaderTitle}>TITLE</span>
              <span>STATUS</span>
              <span>PRIORITY</span>
              <span className={styles.listHeaderDate}>DATE</span>
            </div>

            {items.length === 0 ? (
              <div className={styles.emptyState}>NO FEEDBACK MATCHES THESE FILTERS</div>
            ) : (
              items.map((item) => {
                const isSelected = item.id === selectedId
                return (
                  <Link
                    key={item.id}
                    href={href(state, { selected: item.id })}
                    className={isSelected ? `${styles.row} ${styles.rowSelected}` : styles.row}
                  >
                    <div className={styles.rowTitleCell}>
                      <span className={`${styles.rowStripe} ${typeStripeClass(item.type)}`} />
                      <div className={styles.rowTitleGroup}>
                        <div className={isSelected ? styles.rowTitleSelected : styles.rowTitle}>{item.title}</div>
                        <div className={styles.rowSubline}>
                          {TYPE_LABELS[item.type]} · {item.companyName || '—'} · {item.userName || '—'}
                        </div>
                      </div>
                    </div>
                    <span className={`${styles.statusTag} ${statusClass(item.status)}`}>
                      <span className={styles.statusDot} />
                      {STATUS_BTN_LABELS[item.status]}
                    </span>
                    <span className={`${styles.priorityLabel} ${priorityClass(item.priority)}`}>
                      {PRIORITY_BTN_LABELS[item.priority]}
                    </span>
                    <span className={styles.rowDate}>{formatShortDate(item.submittedAt)}</span>
                  </Link>
                )
              })
            )}
          </div>
        </div>

        <aside className={styles.detail}>
          {selectedItem ? (
            <>
              <div className={styles.detailHeader}>
                <div className={styles.detailTopRow}>
                  <div className={styles.detailTypeBadge}>
                    <span className={`${styles.typeBadge} ${typeBadgeClass(selectedItem.type)}`}>
                      {TYPE_LABELS[selectedItem.type]}
                    </span>
                    <span className={`${styles.priorityLabel} ${priorityClass(selectedItem.priority)}`}>
                      {PRIORITY_BTN_LABELS[selectedItem.priority]} PRIORITY
                    </span>
                  </div>
                  <span className={styles.detailRef}>#{selectedItem.id}</span>
                </div>
                <span className={styles.detailTitle}>{selectedItem.title}</span>
                <div className={styles.detailMetaCol}>
                  {selectedItem.companyId ? (
                    <Link href={`/operator/customers/${selectedItem.companyId}`} className={styles.detailCompanyLink}>
                      {selectedItem.companyName || '(unnamed)'} →
                    </Link>
                  ) : (
                    <span className={styles.detailCompanyLink}>{selectedItem.companyName || '—'}</span>
                  )}
                  <span className={styles.detailSubmitter}>
                    {selectedItem.userName || '—'}
                    {selectedItem.userEmail ? ` · ${selectedItem.userEmail}` : ''}
                  </span>
                  <span className={styles.detailDate}>{formatFullDateTime(selectedItem.submittedAt)}</span>
                </div>
              </div>

              {selectedItem.description && (
                <div className={styles.detailSection}>
                  <span className={styles.sectionLabel}>DESCRIPTION</span>
                  <span className={styles.detailBody}>{selectedItem.description}</span>
                </div>
              )}

              <div className={styles.settersBlock}>
                <div className={styles.settersGroup}>
                  <span className={styles.sectionLabel}>STATUS</span>
                  <div className={styles.setterRow}>
                    {(['open', 'in_progress', 'done', 'wont_fix'] as FeedbackStatus[]).map((s) => (
                      <SetterButton
                        key={s}
                        label={STATUS_BTN_LABELS[s]}
                        active={selectedItem.status === s}
                        disabled={pending}
                        onClick={() => handleStatusSet(s)}
                      />
                    ))}
                  </div>
                </div>
                <div className={styles.settersGroup}>
                  <span className={styles.sectionLabel}>PRIORITY</span>
                  <div className={styles.setterRow}>
                    {(['low', 'medium', 'high'] as FeedbackPriority[]).map((p) => (
                      <SetterButton
                        key={p}
                        label={PRIORITY_BTN_LABELS[p]}
                        active={selectedItem.priority === p}
                        danger={p === 'high'}
                        disabled={pending}
                        onClick={() => handlePrioritySet(p)}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div className={styles.notesSection}>
                <div className={styles.notesHeaderRow}>
                  <span className={styles.sectionLabel}>INTERNAL NOTES</span>
                  {selectedNotes.length > 0 && (
                    <span className={styles.noteCount}>
                      {selectedNotes.length} {selectedNotes.length === 1 ? 'NOTE' : 'NOTES'}
                    </span>
                  )}
                </div>
                {selectedNotes.length === 0 ? (
                  <span className={styles.emptyNotes}>No internal notes yet.</span>
                ) : (
                  selectedNotes.map((n) => (
                    <div key={n.id} className={styles.noteItem}>
                      <div className={styles.noteMeta}>
                        <span className={styles.noteAuthor}>{n.createdBy}</span>
                        <span>{formatFullDateTime(n.createdAt)}</span>
                      </div>
                      <span className={styles.noteText}>{n.text}</span>
                    </div>
                  ))
                )}
                <textarea
                  className={styles.composerTextarea}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Add an internal note…"
                />
                <button
                  type="button"
                  className={hasDraft ? styles.saveNoteActive : styles.saveNote}
                  onClick={handleAddNote}
                  disabled={!hasDraft || pending}
                >
                  SAVE NOTE
                </button>
              </div>
            </>
          ) : (
            <div className={styles.emptyState}>NO FEEDBACK SELECTED</div>
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
            placeholder="Search titles, companies, users"
            defaultValue={query}
            onChange={handleSearch}
          />
        </div>

        <div className={styles.mobileChipRow}>
          {FEEDBACK_STATUS_FILTERS.map((s) => (
            <Link
              key={s}
              href={href(state, { status: s })}
              className={s === status ? `${styles.mobileChip} ${styles.mobileChipActive}` : styles.mobileChip}
            >
              {STATUS_FILTER_LABELS[s]}
              <span className={styles.mobileChipCount}>{statusCounts[s] ?? 0}</span>
            </Link>
          ))}
        </div>

        <div className={styles.mobileChipRow}>
          {FEEDBACK_TYPE_FILTERS.map((t) => (
            <Link
              key={t}
              href={href(state, { type: t })}
              className={t === type ? `${styles.mobileChip} ${styles.mobileChipActive}` : styles.mobileChip}
            >
              {TYPE_FILTER_LABELS[t]}
              <span className={styles.mobileChipCount}>{typeCounts[t] ?? 0}</span>
            </Link>
          ))}
        </div>

        <div className={styles.mobileSortRow}>
          <div className={styles.mobileSortLinks}>
            {FEEDBACK_SORTS.map((s) => (
              <Link key={s} href={href(state, { sort: s })} className={s === sort ? styles.mobileSortLinkActive : styles.mobileSortLink}>
                {SORT_LABELS[s]}
              </Link>
            ))}
          </div>
          <span className={styles.resultLabel}>{resultLabel}</span>
        </div>

        <div className={styles.mobileList}>
          {items.length === 0 ? (
            <div className={styles.emptyState}>NO FEEDBACK MATCHES THESE FILTERS</div>
          ) : (
            items.map((item) => (
              <Link key={item.id} href={`/operator/feedback/${item.id}`} className={styles.mobileRow}>
                <span className={`${styles.mobileRowStripe} ${typeStripeClass(item.type)}`} />
                <div className={styles.mobileRowInfo}>
                  <span className={styles.mobileRowTitle}>{item.title}</span>
                  <div className={styles.mobileRowMeta}>
                    <span className={`${styles.statusTag} ${statusClass(item.status)}`}>
                      <span className={styles.statusDot} />
                      {STATUS_BTN_LABELS[item.status]}
                    </span>
                    <span className={styles.mobileMetaDot}>·</span>
                    <span className={priorityClass(item.priority)}>{PRIORITY_BTN_LABELS[item.priority]}</span>
                    <span className={styles.mobileMetaDot}>·</span>
                    <span className={styles.rowDate}>{formatShortDate(item.submittedAt)}</span>
                  </div>
                  <span className={styles.mobileRowSubline}>
                    {TYPE_LABELS[item.type]} · {item.companyName || '—'} · {item.userName || '—'}
                  </span>
                </div>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
