'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { OperatorFeedback, FeedbackType, FeedbackStatus, FeedbackPriority } from '@/types/operator'
import { updateFeedbackStatus, createFeedback } from './actions'
import styles from './feedback.module.css'

interface FeedbackListViewProps {
  items: OperatorFeedback[]
  activeType: string
  activeStatus: string
}

const TYPE_FILTERS = [
  { key: 'all',             label: 'All'             },
  { key: 'feature_request', label: 'Feature Request' },
  { key: 'bug_report',      label: 'Bug Report'      },
]

const STATUS_FILTERS = [
  { key: 'all',         label: 'All'         },
  { key: 'open',        label: 'Open'        },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'done',        label: 'Done'        },
  { key: 'wont_fix',    label: "Won't Fix"   },
]

function formatDate(iso: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

function typeBadgeClass(type: FeedbackType): string {
  return type === 'bug_report' ? styles.badgeBug : styles.badgeFeature
}

function typeLabel(type: FeedbackType): string {
  return type === 'bug_report' ? 'Bug' : 'Feature'
}

function priorityBadgeClass(priority: FeedbackPriority): string {
  switch (priority) {
    case 'high':   return styles.badgePriorityHigh
    case 'medium': return styles.badgePriorityMedium
    default:       return styles.badgePriorityLow
  }
}

export default function FeedbackListView({ items, activeType, activeStatus }: FeedbackListViewProps) {
  const router = useRouter()
  const [showForm, setShowForm] = useState(false)
  const [formType, setFormType] = useState<FeedbackType>('feature_request')
  const [formTitle, setFormTitle] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formCompanyId, setFormCompanyId] = useState('')
  const [formCompanyName, setFormCompanyName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')

  function buildUrl(type: string, status: string) {
    const params = new URLSearchParams()
    if (type !== 'all') params.set('type', type)
    if (status !== 'all') params.set('status', status)
    const qs = params.toString()
    return `/operator/feedback${qs ? '?' + qs : ''}`
  }

  function handleTypeFilter(key: string) {
    router.replace(buildUrl(key, activeStatus))
  }

  function handleStatusFilter(key: string) {
    router.replace(buildUrl(activeType, key))
  }

  async function handleStatusChange(id: string, status: FeedbackStatus) {
    await updateFeedbackStatus(id, status)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!formTitle.trim()) return
    setSubmitting(true)
    setFormError('')
    const result = await createFeedback({
      type: formType,
      title: formTitle.trim(),
      description: formDescription.trim(),
      companyId: formCompanyId.trim(),
      companyName: formCompanyName.trim(),
    })
    setSubmitting(false)
    if (result.error) {
      setFormError(result.error)
    } else {
      setShowForm(false)
      setFormTitle('')
      setFormDescription('')
      setFormCompanyId('')
      setFormCompanyName('')
    }
  }

  return (
    <div>
      <div className={styles.header}>
        <h1 className={styles.pageTitle}>Feedback</h1>
        <button className={styles.logBtn} onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : 'Log Item'}
        </button>
      </div>

      <div className={styles.filterBar}>
        <div className={styles.filterGroup}>
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.key}
              className={`${styles.filterBtn} ${activeType === f.key ? styles.filterBtnActive : ''}`}
              onClick={() => handleTypeFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className={styles.filterGroup}>
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              className={`${styles.filterBtn} ${activeStatus === f.key ? styles.filterBtnActive : ''}`}
              onClick={() => handleStatusFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {showForm && (
        <form className={styles.inlineForm} onSubmit={handleSubmit}>
          <div className={styles.formRow}>
            <label className={styles.formLabel}>Type</label>
            <select
              className={styles.formSelect}
              value={formType}
              onChange={(e) => setFormType(e.target.value as FeedbackType)}
            >
              <option value="feature_request">Feature Request</option>
              <option value="bug_report">Bug Report</option>
            </select>
          </div>
          <div className={styles.formRow}>
            <label className={styles.formLabel}>Title</label>
            <input
              className={styles.formInput}
              type="text"
              value={formTitle}
              onChange={(e) => setFormTitle(e.target.value)}
              placeholder="Short description…"
              required
            />
          </div>
          <div className={styles.formRow}>
            <label className={styles.formLabel}>Description</label>
            <textarea
              className={styles.formTextarea}
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              placeholder="Full details…"
            />
          </div>
          <div className={styles.formRow}>
            <label className={styles.formLabel}>Company ID (optional)</label>
            <input
              className={styles.formInput}
              type="text"
              value={formCompanyId}
              onChange={(e) => setFormCompanyId(e.target.value)}
              placeholder="Firestore company ID…"
            />
          </div>
          <div className={styles.formRow}>
            <label className={styles.formLabel}>Company Name (optional)</label>
            <input
              className={styles.formInput}
              type="text"
              value={formCompanyName}
              onChange={(e) => setFormCompanyName(e.target.value)}
              placeholder="Display name…"
            />
          </div>
          {formError && (
            <p style={{ color: 'var(--error)', fontSize: '13px' }}>{formError}</p>
          )}
          <div className={styles.formActions}>
            <button type="submit" className={styles.submitBtn} disabled={submitting || !formTitle.trim()}>
              {submitting ? 'Saving…' : 'Log Item'}
            </button>
            <button
              type="button"
              className={styles.cancelBtn}
              onClick={() => setShowForm(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className={styles.list}>
        {items.length === 0 ? (
          <p className={styles.emptyState}>No feedback logged yet</p>
        ) : (
          items.map((item) => (
            <div key={item.id} className={styles.item}>
              <div className={styles.itemHeader}>
                <p className={styles.itemTitle}>{item.title}</p>
                <div className={styles.itemBadges}>
                  <span className={`${styles.badge} ${typeBadgeClass(item.type)}`}>
                    {typeLabel(item.type)}
                  </span>
                  <span className={`${styles.badge} ${priorityBadgeClass(item.priority)}`}>
                    {item.priority}
                  </span>
                </div>
              </div>
              {item.description && (
                <p className={styles.itemDescription}>{item.description}</p>
              )}
              <div className={styles.itemMeta}>
                <select
                  className={styles.statusSelect}
                  defaultValue={item.status}
                  onChange={(e) => handleStatusChange(item.id, e.target.value as FeedbackStatus)}
                >
                  <option value="open">Open</option>
                  <option value="in_progress">In Progress</option>
                  <option value="done">Done</option>
                  <option value="wont_fix">Won&apos;t Fix</option>
                </select>
                {item.companyName && (
                  <span className={styles.itemMetaText}>{item.companyName}</span>
                )}
                <span className={styles.itemMetaText}>{formatDate(item.submittedAt)}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
