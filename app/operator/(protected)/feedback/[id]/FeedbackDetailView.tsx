'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import type {
  OperatorFeedback,
  FeedbackTimelineEntry,
  FeedbackStatus,
  FeedbackPriority,
  StoredFeedbackStatus,
  StoredFeedbackPriority,
  StoredFeedbackType,
} from '@/types/operator'
import { updateFeedbackStatus, updateFeedbackPriority, addFeedbackNote } from '../actions'
import styles from './detail.module.css'

export interface SubmitterInfo {
  email: string
  role: string
  plan: string
}

export interface RelatedFeedback {
  id: string
  title: string
  // Stored*, not the settable unions — a related ticket is read straight
  // out of Firestore, same as `item` itself.
  type: StoredFeedbackType
  status: StoredFeedbackStatus
  submittedAt: string
}

interface Props {
  item: OperatorFeedback
  timeline: FeedbackTimelineEntry[]
  submitter: SubmitterInfo
  related: RelatedFeedback[]
}

// 'unknown' (see types/operator.ts) is never set by any writer — it only
// ever appears when a document is missing the field — so it gets its own
// label/colour rather than quietly inheriting SUPPORT/NO ACTION/LOW's
// styling, which would look like a normal ticket instead of a corrupt one.
const TYPE_LABELS: Record<StoredFeedbackType, string> = {
  bug_report: 'BUG',
  feature_request: 'FEATURE',
  support: 'SUPPORT',
  unknown: 'UNKNOWN',
}

const STATUS_LABELS: Record<StoredFeedbackStatus, string> = {
  open: 'OPEN',
  in_progress: 'IN PROGRESS',
  done: 'DONE',
  wont_fix: 'NO ACTION',
  unknown: 'UNKNOWN',
}

const PRIORITY_LABELS: Record<StoredFeedbackPriority, string> = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  unknown: 'UNKNOWN',
}

function typeClass(type: StoredFeedbackType): string {
  if (type === 'bug_report') return styles.typeBug
  if (type === 'feature_request') return styles.typeFeature
  if (type === 'support') return styles.typeSupport
  return styles.typeUnknown
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

// Dot/hex values the CSS classes above don't already cover (inline, since
// the dot's colour also has to travel to the thread's connector — see
// buildThread below).
const TYPE_DOT: Record<StoredFeedbackType, string> = {
  bug_report: 'var(--danger)',
  feature_request: '#9fb3c8',
  support: 'var(--accent)',
  unknown: '#4a4b52',
}
const NOTE_DOT = '#9fb3c8'
const EVENT_DOT_OPERATOR = 'var(--accent)'
const EVENT_DOT_SYSTEM = '#4a4b52'

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

function formatShortDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]}`
}

function formatFullDateTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${formatShortDate(iso)} ${d.getFullYear()} · ${hh}:${mm}`
}

interface ThreadItem {
  id: string
  kind: 'report' | 'note' | 'event'
  createdAt: string
  author: string
  authorClassName: string
  dotColor: string
  text?: string
}

/** Prepends the synthetic "report" entry (the feedback document itself —
 *  never stored in the notes subcollection, see FeedbackTimelineEntry's doc
 *  comment) to the fetched note/event entries. `timeline` already arrives
 *  sorted ascending by createdAt, and the report is always earliest. */
function buildThread(item: OperatorFeedback, timeline: FeedbackTimelineEntry[]): ThreadItem[] {
  const report: ThreadItem = {
    id: `${item.id}-report`,
    kind: 'report',
    createdAt: item.submittedAt,
    author: `${item.userName || 'Unknown'} · ${item.companyName || '—'}`,
    authorClassName: styles.authorBright,
    dotColor: TYPE_DOT[item.type],
  }
  const rest: ThreadItem[] = timeline.map((entry) => {
    if (entry.kind === 'note') {
      return {
        id: entry.id,
        kind: 'note',
        createdAt: entry.createdAt,
        author: entry.createdBy,
        authorClassName: styles.authorNote,
        dotColor: NOTE_DOT,
        text: entry.text,
      }
    }
    // Every event this app writes today is operator-made (see
    // app/operator/feedback/actions.ts) — the system/grey case has no
    // current writer, but stays modelled for a future automated event
    // (e.g. a webhook-driven status change) rather than being assumed away.
    const isSystem = !entry.createdBy
    return {
      id: entry.id,
      kind: 'event',
      createdAt: entry.createdAt,
      author: isSystem ? 'SYSTEM' : entry.createdBy,
      authorClassName: styles.authorMuted,
      dotColor: isSystem ? EVENT_DOT_SYSTEM : EVENT_DOT_OPERATOR,
      text: entry.text,
    }
  })
  return [report, ...rest]
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

export default function FeedbackDetailView({ item, timeline, submitter, related }: Props) {
  const [draft, setDraft] = useState('')
  const [pending, startTransition] = useTransition()

  const thread = buildThread(item, timeline)
  const hasDraft = draft.trim().length > 0

  function handleStatusSet(next: FeedbackStatus) {
    if (item.status === next) return
    startTransition(async () => {
      await updateFeedbackStatus(item.id, next)
    })
  }

  function handlePrioritySet(next: FeedbackPriority) {
    if (item.priority === next) return
    startTransition(async () => {
      await updateFeedbackPriority(item.id, next)
    })
  }

  function handleAddNote() {
    if (!draft.trim()) return
    const text = draft
    startTransition(async () => {
      const result = await addFeedbackNote(item.id, text)
      if (!result.error) setDraft('')
    })
  }

  const submittedRows: { label: string; value: string; bright?: boolean }[] = [
    { label: 'Name', value: item.userName || '—', bright: true },
    { label: 'Email', value: submitter.email || '—' },
    { label: 'Role', value: submitter.role || '—' },
    { label: 'Company', value: item.companyName || '—' },
    { label: 'Plan', value: submitter.plan || '—' },
    { label: 'Submitted', value: formatFullDateTime(item.submittedAt) },
  ]

  const settersBlock = (
    <div className={styles.settersBlock}>
      <div className={styles.settersGroup}>
        <span className={styles.sectionLabel}>STATUS</span>
        <div className={styles.setterRow}>
          {(['open', 'in_progress', 'done', 'wont_fix'] as FeedbackStatus[]).map((s) => (
            <SetterButton
              key={s}
              label={STATUS_LABELS[s]}
              active={item.status === s}
              disabled={pending}
              onClick={() => handleStatusSet(s)}
            />
          ))}
        </div>
      </div>
      <div className={styles.settersGroup}>
        <span className={styles.sectionLabel}>PRIORITY</span>
        <div className={styles.setterRow} data-priority="">
          {(['low', 'medium', 'high'] as FeedbackPriority[]).map((p) => (
            <SetterButton
              key={p}
              label={PRIORITY_LABELS[p]}
              active={item.priority === p}
              danger={p === 'high'}
              disabled={pending}
              onClick={() => handlePrioritySet(p)}
            />
          ))}
        </div>
      </div>
    </div>
  )

  return (
    <div className={styles.screen}>
      <div className={styles.main}>
        <div className={styles.header}>
          <div className={styles.crumbRow}>
            <Link href="/operator/feedback" className={styles.backLink}>← ALL FEEDBACK</Link>
            <span className={styles.crumbSep}>/</span>
            <span className={styles.crumbRef}>#{item.id}</span>
          </div>
          <span className={styles.title}>{item.title}</span>
          <div className={styles.metaRow}>
            <span className={typeClass(item.type)}>{TYPE_LABELS[item.type]}</span>
            <span className={styles.metaDot}>·</span>
            <span className={`${styles.statusTag} ${statusClass(item.status)}`}>
              <span className={styles.statusDot} />
              {STATUS_LABELS[item.status]}
            </span>
            <span className={styles.metaDot}>·</span>
            <span className={priorityClass(item.priority)}>{PRIORITY_LABELS[item.priority]} PRIORITY</span>
            <span className={styles.metaDot}>·</span>
            <span className={styles.metaCompanyUser}>
              {item.companyName || '—'} · {item.userName || '—'}
            </span>
          </div>
        </div>

        {/* Mobile only — desktop renders this same block in the aside below.
            See detail.module.css's .settersMobileOnly comment for why. */}
        <div className={styles.settersMobileOnly}>{settersBlock}</div>

        <div className={styles.threadScroll}>
          {thread.map((entry, i) => (
            <div key={entry.id} className={styles.threadEntry}>
              <div className={styles.threadRail}>
                <span className={styles.threadDot} style={{ background: entry.dotColor }} />
                {i < thread.length - 1 && <span className={styles.threadLine} />}
              </div>
              <div className={styles.threadBody}>
                <div className={styles.threadMeta}>
                  <span className={entry.authorClassName}>{entry.author}</span>
                  <span>{formatFullDateTime(entry.createdAt)}</span>
                </div>
                {entry.kind === 'report' && (
                  <div className={styles.reportCard}>
                    <span className={styles.reportEyebrow}>ORIGINAL REPORT</span>
                    <span className={styles.reportBody}>{item.description || '—'}</span>
                  </div>
                )}
                {entry.kind === 'event' && <span className={styles.eventText}>{entry.text}</span>}
                {entry.kind === 'note' && <span className={styles.noteText}>{entry.text}</span>}
              </div>
            </div>
          ))}
        </div>

        <div className={styles.composer}>
          <textarea
            className={styles.composerTextarea}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add an internal note…"
          />
          <div className={styles.composerFooter}>
            <span className={styles.composerHelper}>Notes are internal — the customer never sees them</span>
            <button
              type="button"
              className={hasDraft ? styles.saveNoteActive : styles.saveNote}
              onClick={handleAddNote}
              disabled={!hasDraft || pending}
            >
              SAVE NOTE
            </button>
          </div>
        </div>
      </div>

      <aside className={styles.aside}>
        {/* Desktop only — mobile renders this same block above the thread.
            See detail.module.css's .settersDesktopOnly comment for why. */}
        <div className={styles.settersDesktopOnly}>{settersBlock}</div>

        <div className={styles.submittedBlock}>
          <span className={`${styles.sectionLabel} ${styles.submittedHeading}`}>SUBMITTED BY</span>
          {submittedRows.map((r) => (
            <div key={r.label} className={styles.submittedRow}>
              <span className={styles.submittedLabel}>{r.label}</span>
              <span className={r.bright ? `${styles.submittedValue} ${styles.submittedValueBright}` : styles.submittedValue}>
                {r.value}
              </span>
            </div>
          ))}
          {item.companyId && (
            <Link href={`/operator/customers/${item.companyId}`} className={styles.openCustomerLink}>
              OPEN CUSTOMER →
            </Link>
          )}
        </div>

        <div className={styles.relatedBlock}>
          <span className={styles.sectionLabel}>MORE FROM THIS CUSTOMER</span>
          {related.length === 0 ? (
            <span className={styles.emptyRelated}>No other feedback from this customer.</span>
          ) : (
            related.map((r) => (
              <Link key={r.id} href={`/operator/feedback/${r.id}`} className={styles.relatedItem}>
                <span className={styles.relatedTitle}>{r.title}</span>
                <span className={`${styles.relatedMeta} ${statusClass(r.status)}`}>
                  {TYPE_LABELS[r.type]} · {STATUS_LABELS[r.status]} · {formatShortDate(r.submittedAt)}
                </span>
              </Link>
            ))
          )}
        </div>
      </aside>
    </div>
  )
}
