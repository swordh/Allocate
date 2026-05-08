'use client'

import { useState, useCallback } from 'react'
import { useSupportContext } from '@/lib/support-context'
import { useToast } from '@/lib/toast-context'
import { submitFeedback } from '@/actions/submitFeedback'
import { getRecentActions } from '@/lib/action-tracker'
import styles from './SupportModal.module.css'

// ── Bug form ────────────────────────────────────────────────────────────────

const SEVERITIES = [
  { key: 'low' as const, label: 'Low', desc: 'Cosmetic, easy workaround.' },
  { key: 'medium' as const, label: 'Medium', desc: 'Annoying, but I can keep working.' },
  { key: 'high' as const, label: 'High', desc: 'Blocking — cannot complete a task.' },
]

const AREAS = ['Bookings', 'Equipment', 'Settings', 'Calendar', 'Notifications', 'Login / Auth', 'Other']

function BugForm({ onSubmit }: { onSubmit: (title: string, description: string) => void }) {
  const [title, setTitle] = useState('')
  const [steps, setSteps] = useState('')
  const [severity, setSeverity] = useState<'low' | 'medium' | 'high' | null>(null)
  const [area, setArea] = useState('Bookings')
  const [includeDiag, setIncludeDiag] = useState(false)
  const canSend = title.trim().length > 4 && steps.trim().length > 8 && severity !== null

  const handleSubmit = () => {
    let diagBlock = ''
    if (includeDiag) {
      const ua = navigator.userAgent
      const url = window.location.href
      const actions = getRecentActions()
      diagBlock = `\n\n--- Diagnostics ---\nBrowser: ${ua}\nURL: ${url}\n\nLast actions:\n${actions}\n--- End diagnostics ---`
    }
    const description = `Severity: ${severity}\nArea: ${area}\n\nSteps to reproduce:\n${steps}${diagBlock}`
    onSubmit(title.trim(), description)
  }

  return (
    <>
      <p className={styles.lead}>Describe what happened, where in the app it occurred, and how we can reproduce it.</p>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Headline</span>
        <input
          className={styles.input}
          type="text"
          placeholder="A brief description of what isn't working"
          value={title}
          onChange={e => setTitle(e.target.value)}
          maxLength={200}
        />
      </label>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>What happened?</span>
        <textarea
          className={styles.textarea}
          placeholder={"1. Navigate to...\n2. Click on...\n3. ...\n\nExpected: ...\nActual: ..."}
          value={steps}
          onChange={e => setSteps(e.target.value)}
          maxLength={2000}
        />
        <span className={styles.hint}>Include steps to reproduce, what you expected, and what happened instead.</span>
      </label>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>Severity</span>
        <div className={styles.severity}>
          {SEVERITIES.map(s => (
            <button
              key={s.key}
              type="button"
              className={`${styles.sevBtn} ${severity === s.key ? styles.sevBtnActive : ''}`}
              onClick={() => setSeverity(s.key)}
            >
              <span className={styles.sevName}>{s.label}</span>
              <span className={styles.sevDesc}>{s.desc}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={styles.row2}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Where in Allocate?</span>
          <select className={styles.select} value={area} onChange={e => setArea(e.target.value)}>
            {AREAS.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
      </div>

      <label className={styles.checkboxField}>
        <input
          type="checkbox"
          checked={includeDiag}
          onChange={e => setIncludeDiag(e.target.checked)}
          className={styles.checkbox}
        />
        <span className={styles.checkboxLabel}>
          Include diagnostics — browser, version, current URL, and last 50 actions.
        </span>
      </label>

      <div className={styles.tabActions}>
        <button
          type="button"
          className={`${styles.submitBtn} ${!canSend ? styles.submitBtnDisabled : ''}`}
          disabled={!canSend}
          onClick={handleSubmit}
        >
          Send report
        </button>
      </div>
    </>
  )
}

// ── Feature form ────────────────────────────────────────────────────────────

const FEATURE_TAGS = ['Calendar', 'Equipment', 'Permissions', 'Mobile', 'Integrations', 'Reporting', 'Notifications']

function FeatureForm({ onSubmit }: { onSubmit: (title: string, description: string) => void }) {
  const [title, setTitle] = useState('')
  const [why, setWhy] = useState('')
  const [tags, setTags] = useState<Set<string>>(new Set())
  const canSend = title.trim().length > 4 && why.trim().length > 8

  const toggleTag = (tag: string) => {
    setTags(prev => {
      const next = new Set(prev)
      next.has(tag) ? next.delete(tag) : next.add(tag)
      return next
    })
  }

  const handleSubmit = () => {
    const tagLine = tags.size > 0 ? `\nArea: ${[...tags].join(', ')}\n\n` : '\n\n'
    const description = `${tagLine}${why.trim()}`
    onSubmit(title.trim(), description)
  }

  return (
    <>
      <p className={styles.lead}>Describe the change you'd like to see and the problem it would solve.</p>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>In one sentence</span>
        <input
          className={styles.input}
          type="text"
          placeholder="A brief description of the feature you have in mind"
          value={title}
          onChange={e => setTitle(e.target.value)}
          maxLength={200}
        />
      </label>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>What problem does this solve?</span>
        <textarea
          className={styles.textarea}
          placeholder={"Describe the situation where this would be useful and how it would help your workflow."}
          value={why}
          onChange={e => setWhy(e.target.value)}
          maxLength={2000}
        />
      </label>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>Area</span>
        <div className={styles.pills}>
          {FEATURE_TAGS.map(tag => (
            <button
              key={tag}
              type="button"
              className={`${styles.pill} ${tags.has(tag) ? styles.pillActive : ''}`}
              onClick={() => toggleTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.tabActions}>
        <button
          type="button"
          className={`${styles.submitBtn} ${!canSend ? styles.submitBtnDisabled : ''}`}
          disabled={!canSend}
          onClick={handleSubmit}
        >
          Submit request
        </button>
      </div>
    </>
  )
}

// ── Help form ────────────────────────────────────────────────────────────────

function HelpForm({ onSubmit }: { onSubmit: (title: string, description: string) => void }) {
  const [topic, setTopic] = useState('')
  const [msg, setMsg] = useState('')
  const canSend = topic.trim().length > 3 && msg.trim().length > 8

  return (
    <>
      <p className={styles.lead}>Describe what you're trying to do or what's unclear and we'll get back to you.</p>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Subject</span>
        <input
          className={styles.input}
          type="text"
          placeholder="A brief description of what you need help with"
          value={topic}
          onChange={e => setTopic(e.target.value)}
          maxLength={200}
        />
      </label>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Message</span>
        <textarea
          className={styles.textarea}
          placeholder="Describe your question or the situation in as much detail as you can."
          value={msg}
          onChange={e => setMsg(e.target.value)}
          maxLength={2000}
        />
      </label>

      <div className={styles.tabActions}>
        <button
          type="button"
          className={`${styles.submitBtn} ${!canSend ? styles.submitBtnDisabled : ''}`}
          disabled={!canSend}
          onClick={() => onSubmit(topic.trim(), msg.trim())}
        >
          Send message
        </button>
      </div>
    </>
  )
}

// ── Main modal ──────────────────────────────────────────────────────────────

export default function SupportModal() {
  const { helpOpen, activeTab, closeHelp, openHelp } = useSupportContext()
  const { showToast } = useToast()
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState<{ ticketId: string; kind: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Reset on tab change
  const handleTabChange = useCallback((tab: Parameters<typeof openHelp>[0]) => {
    setSubmitted(null)
    setError(null)
    openHelp(tab)
  }, [openHelp])

  const handleClose = useCallback(() => {
    closeHelp()
    setTimeout(() => { setSubmitted(null); setError(null) }, 200)
  }, [closeHelp])

  const handleSubmit = async (type: 'bug_report' | 'feature_request' | 'support', title: string, description: string) => {
    setSubmitting(true)
    setError(null)
    try {
      const result = await submitFeedback({ type, title, description })
      if ('error' in result) {
        setError(result.error)
      } else {
        const kindLabel = type === 'bug_report' ? 'Bug report' : type === 'feature_request' ? 'Feature request' : 'Message'
        setSubmitted({ ticketId: result.ticketId, kind: kindLabel })
        showToast('success', `${kindLabel} sent — ref ${result.ticketId}`, 4000)
        setTimeout(() => handleClose(), 2200)
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (!helpOpen) return null

  return (
    <div className={styles.backdrop} onClick={handleClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-label="Help & feedback"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className={styles.header}>
          <span className={styles.headerTitle}>Help &amp; feedback</span>
          <button className={styles.closeBtn} onClick={handleClose} aria-label="Close">
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>close</span>
          </button>
        </div>

        {/* Tabs */}
        {!submitted && (
          <div className={styles.tabs} role="tablist">
            <button
              role="tab"
              aria-selected={activeTab === 'bug'}
              className={`${styles.tab} ${activeTab === 'bug' ? styles.tabActive : ''}`}
              onClick={() => handleTabChange('bug')}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>bug_report</span>
              Bug report
              <span className={styles.tabNum}>01</span>
            </button>
            <button
              role="tab"
              aria-selected={activeTab === 'feature'}
              className={`${styles.tab} ${activeTab === 'feature' ? styles.tabActive : ''}`}
              onClick={() => handleTabChange('feature')}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>lightbulb</span>
              Feature request
              <span className={styles.tabNum}>02</span>
            </button>
            <button
              role="tab"
              aria-selected={activeTab === 'help'}
              className={`${styles.tab} ${activeTab === 'help' ? styles.tabActive : ''}`}
              onClick={() => handleTabChange('help')}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>support_agent</span>
              Get help
              <span className={styles.tabNum}>03</span>
            </button>
          </div>
        )}

        {/* Body */}
        <div className={styles.body}>
          {submitted ? (
            <div className={styles.success}>
              <span className={`material-symbols-outlined ${styles.successIcon}`}>check_circle</span>
              <h3 className={styles.successTitle}>{submitted.kind} sent</h3>
              <p className={styles.successDesc}>
                {activeTab === 'bug' && 'Thanks — we triage incoming reports within one business day.'}
                {activeTab === 'feature' && 'Thanks for the suggestion. We review the request board every Friday.'}
                {activeTab === 'help' && 'Our support team replies within a few hours during business days.'}
              </p>
              <div className={styles.ticketBadge}>
                <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>confirmation_number</span>
                {submitted.ticketId}
              </div>
            </div>
          ) : submitting ? (
            <div className={styles.loadingState}>
              <p className={styles.loadingText}>Sending…</p>
            </div>
          ) : (
            <>
              {error && <p className={styles.errorMsg}>{error}</p>}
              {activeTab === 'bug' && (
                <BugForm onSubmit={(title, desc) => handleSubmit('bug_report', title, desc)} />
              )}
              {activeTab === 'feature' && (
                <FeatureForm onSubmit={(title, desc) => handleSubmit('feature_request', title, desc)} />
              )}
              {activeTab === 'help' && (
                <HelpForm onSubmit={(title, desc) => handleSubmit('support', title, desc)} />
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {submitted && (
          <div className={styles.footer}>
            <div className={styles.footerActions}>
              <button className={styles.ghostBtn} onClick={() => { setSubmitted(null); setError(null) }}>Send another</button>
              <button className={styles.primaryBtn} onClick={handleClose}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
