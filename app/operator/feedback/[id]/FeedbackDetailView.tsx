'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { OperatorFeedback, FeedbackNote, FeedbackStatus, FeedbackPriority, FeedbackType } from '@/types/operator'
import { updateFeedbackStatus, updateFeedbackPriority, addFeedbackNote } from './actions'
import styles from './detail.module.css'

interface Props {
  item: OperatorFeedback
  notes: FeedbackNote[]
}

function formatDate(iso: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

function formatDateTime(iso: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('sv-SE', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function typeLabel(type: FeedbackType): string {
  if (type === 'bug_report') return 'Bug'
  if (type === 'feature_request') return 'Feature'
  return 'Support'
}

function typeBadgeClass(type: FeedbackType, s: Record<string, string>): string {
  if (type === 'bug_report') return s.badgeBug
  if (type === 'feature_request') return s.badgeFeature
  return s.badgeSupport
}

function priorityBadgeClass(priority: FeedbackPriority, s: Record<string, string>): string {
  if (priority === 'high') return s.badgePriorityHigh
  if (priority === 'medium') return s.badgePriorityMedium
  return s.badgePriorityLow
}

export default function FeedbackDetailView({ item, notes: initialNotes }: Props) {
  const [status, setStatus] = useState<FeedbackStatus>(item.status)
  const [priority, setPriority] = useState<FeedbackPriority>(item.priority)
  const [notes, setNotes] = useState<FeedbackNote[]>(initialNotes)
  const [noteText, setNoteText] = useState('')
  const [addingNote, setAddingNote] = useState(false)
  const [noteError, setNoteError] = useState('')

  async function handleStatusChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as FeedbackStatus
    setStatus(next)
    await updateFeedbackStatus(item.id, next)
  }

  async function handlePriorityChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as FeedbackPriority
    setPriority(next)
    await updateFeedbackPriority(item.id, next)
  }

  async function handleAddNote(e: React.FormEvent) {
    e.preventDefault()
    if (!noteText.trim()) return
    setAddingNote(true)
    setNoteError('')
    const result = await addFeedbackNote(item.id, noteText)
    if (result.error) {
      setNoteError(result.error)
      setAddingNote(false)
      return
    }
    // Optimistically add to UI (server will revalidate)
    setNotes((prev) => [
      ...prev,
      {
        id: Date.now().toString(),
        text: noteText.trim(),
        createdAt: new Date().toISOString(),
        createdBy: '',
      },
    ])
    setNoteText('')
    setAddingNote(false)
  }

  return (
    <div className={styles.page}>
      <div className={styles.topBar}>
        <Link href="/operator/feedback" className={styles.backLink}>← Feedback</Link>
        <div className={styles.controls}>
          <select className={styles.controlSelect} value={status} onChange={handleStatusChange}>
            <option value="open">Open</option>
            <option value="in_progress">In Progress</option>
            <option value="done">Done</option>
            <option value="wont_fix">Won&apos;t Fix</option>
          </select>
          <select className={styles.controlSelect} value={priority} onChange={handlePriorityChange}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>

      <div className={styles.header}>
        <h1 className={styles.title}>{item.title}</h1>
        <div className={styles.badges}>
          <span className={`${styles.badge} ${typeBadgeClass(item.type, styles)}`}>
            {typeLabel(item.type)}
          </span>
          <span className={`${styles.badge} ${priorityBadgeClass(priority, styles)}`}>
            {priority}
          </span>
        </div>
      </div>

      <div className={styles.metaGrid}>
        <div className={styles.metaField}>
          <span className={styles.metaLabel}>Submitted by</span>
          <span className={styles.metaValue}>{item.userName || '—'}</span>
        </div>
        <div className={styles.metaField}>
          <span className={styles.metaLabel}>Email</span>
          <span className={styles.metaValue}>{item.userEmail || '—'}</span>
        </div>
        <div className={styles.metaField}>
          <span className={styles.metaLabel}>Company</span>
          <span className={styles.metaValue}>{item.companyName || '—'}</span>
        </div>
        <div className={styles.metaField}>
          <span className={styles.metaLabel}>Company ID</span>
          <span className={styles.metaValue}>{item.companyId || '—'}</span>
        </div>
        <div className={styles.metaField}>
          <span className={styles.metaLabel}>Submitted</span>
          <span className={styles.metaValue}>{formatDate(item.submittedAt)}</span>
        </div>
        <div className={styles.metaField}>
          <span className={styles.metaLabel}>User ID</span>
          <span className={`${styles.metaValue} ${styles.metaMono}`}>{item.submittedBy || '—'}</span>
        </div>
        <div className={styles.metaField}>
          <span className={styles.metaLabel}>Ticket ID</span>
          <span className={`${styles.metaValue} ${styles.metaMono}`}>{item.id}</span>
        </div>
        <div className={styles.metaField}>
          <span className={styles.metaLabel}>Status</span>
          <span className={styles.metaValue}>{status.replace('_', ' ')}</span>
        </div>
      </div>

      {item.description && (
        <div className={styles.section}>
          <p className={styles.sectionLabel}>Description</p>
          <p className={styles.description}>{item.description}</p>
        </div>
      )}

      <div className={styles.section}>
        <p className={styles.sectionLabel}>Logbook</p>
        <form className={styles.noteForm} onSubmit={handleAddNote}>
          <textarea
            className={styles.noteTextarea}
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Add a note…"
            rows={3}
          />
          {noteError && <p className={styles.noteError}>{noteError}</p>}
          <button
            type="submit"
            className={styles.noteSubmit}
            disabled={addingNote || !noteText.trim()}
          >
            {addingNote ? 'Adding…' : 'Add Note'}
          </button>
        </form>

        {notes.length === 0 ? (
          <p className={styles.emptyNotes}>No notes yet</p>
        ) : (
          <div className={styles.noteList}>
            {notes.map((note) => (
              <div key={note.id} className={styles.noteItem}>
                <div className={styles.noteMeta}>
                  <span className={styles.noteTime}>{formatDateTime(note.createdAt)}</span>
                  {note.createdBy && <span className={styles.noteAuthor}>{note.createdBy}</span>}
                </div>
                <p className={styles.noteText}>{note.text}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
