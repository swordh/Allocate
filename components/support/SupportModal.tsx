'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import type { KeyboardEvent, FormEvent } from 'react'
import { useSupportContext } from '@/lib/support-context'
import { submitFeedback } from '@/actions/submitFeedback'
import type { FeedbackType } from '@/types/operator'
import Field from '@/components/ui/Field'
import Input from '@/components/ui/Input'
import Textarea from '@/components/ui/Textarea'
import Button from '@/components/ui/Button'
import ErrorBanner from '@/components/ui/ErrorBanner'
import Icon from '@/components/ui/Icon'
import styles from './SupportModal.module.css'

const MAX_DETAILS = 2000

// Design's BUG / FEATURE / SUPPORT map straight onto the existing
// FeedbackType union — no new union, no translation layer. `word` feeds the
// sent-state sentence ("We logged your {word} as #TICKET."); `dotClass`
// points at a CSS class, never an inline colour.
const TYPE_ORDER: FeedbackType[] = ['bug_report', 'feature_request', 'support']

const TYPES: Record<FeedbackType, {
  label: string
  desc: string
  word: string
  placeholder: string
  dotClass: string
}> = {
  bug_report: {
    label: 'BUG',
    desc: 'Something is broken or wrong.',
    word: 'bug report',
    placeholder: 'What did you do, what did you expect, what happened instead?',
    dotClass: styles.dotBug,
  },
  feature_request: {
    label: 'FEATURE',
    desc: 'An idea that would help you.',
    word: 'idea',
    placeholder: 'What are you trying to get done, and where does Allocate get in the way?',
    dotClass: styles.dotFeature,
  },
  support: {
    label: 'QUESTION',
    desc: 'You need a hand with something.',
    word: 'question',
    placeholder: 'Tell us what you need help with.',
    dotClass: styles.dotSupport,
  },
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface SentState {
  ticketId: string
  type: FeedbackType
  subject: string
}

export default function SupportModal() {
  const { helpOpen, closeHelp } = useSupportContext()

  const [type, setType] = useState<FeedbackType>('bug_report')
  const [subject, setSubject] = useState('')
  const [details, setDetails] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<SentState | null>(null)

  const dialogRef = useRef<HTMLDivElement>(null)
  const subjectRef = useRef<HTMLInputElement>(null)
  const sentRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<(HTMLButtonElement | null)[]>([])

  const ready = subject.trim().length > 2 && details.trim().length > 9
  const remaining = MAX_DETAILS - details.length

  // Note the draft is deliberately NOT cleared here — SupportModal is mounted
  // globally (lib/providers.tsx) and just returns null while closed, so
  // "keep the draft for the session" falls out of that for free. Only
  // closing FROM the sent state resets everything, so the next open starts
  // from a blank BUG form.
  const handleClose = useCallback(() => {
    closeHelp()
    // Unconditional: a failed submit's error must never survive a close —
    // otherwise, since the draft is kept, the stale banner would reappear
    // next time the modal opens even though nothing was submitted yet.
    setError(null)
    if (sent) {
      setSent(null)
      setType('bug_report')
      setSubject('')
      setDetails('')
    }
  }, [closeHelp, sent])

  const handleSendAnother = () => {
    setSent(null)
    setType('bug_report')
    setSubject('')
    setDetails('')
    setError(null)
    setTimeout(() => subjectRef.current?.focus(), 0)
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ready || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await submitFeedback({ type, title: subject.trim(), description: details.trim() })
      if ('error' in result) {
        setError(result.error)
      } else {
        setSent({ ticketId: result.ticketId, type, subject: subject.trim() })
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleTypeKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = TYPE_ORDER.indexOf(type)
    let next = idx
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % TYPE_ORDER.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + TYPE_ORDER.length) % TYPE_ORDER.length
    else return
    e.preventDefault()
    setType(TYPE_ORDER[next])
    cardRefs.current[next]?.focus()
  }

  // Effect 1/2 — open state: scroll-lock the body, capture whichever trigger
  // opened us (PrimaryNav's `?`, the MobileMenu row, or Shift+?) as the
  // opener via document.activeElement rather than a shared ref, focus the
  // subject field, and hand focus back to the opener on close.
  useEffect(() => {
    if (!helpOpen) return
    const opener = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    subjectRef.current?.focus()
    return () => {
      document.body.style.overflow = previousOverflow
      opener?.focus()
    }
  }, [helpOpen])

  // Effect 2/2 — Escape + Tab trap. Kept separate from the effect above:
  // handleClose's identity changes when `sent` flips, and if this lived in
  // the same effect that transition would re-run the open-state effect too,
  // stealing focus back to the (now unmounted) subject field.
  useEffect(() => {
    if (!helpOpen) return
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        handleClose()
        return
      }
      if (e.key !== 'Tab') return
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      if (!focusables || focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [helpOpen, handleClose])

  // Move focus onto the confirmation once it appears, for both screen reader
  // and keyboard users.
  useEffect(() => {
    if (sent) sentRef.current?.focus()
  }, [sent])

  if (!helpOpen) return null

  const hint = sent
    ? 'Keep the reference if you need to follow up.'
    : !ready
      ? 'Add a subject and a few lines of detail to send.'
      : ''

  return (
    <div className={styles.overlay} onClick={handleClose}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-feedback-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.grabHandle} aria-hidden="true" />

        <div className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Support</p>
            <h2 id="help-feedback-title" className={styles.title}>Help &amp; feedback</h2>
          </div>
          <button type="button" className={styles.closeBtn} onClick={handleClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className={styles.body}>
          {sent ? (
            <div ref={sentRef} className={styles.sent} role="status" aria-live="polite" tabIndex={-1}>
              <div className={styles.sentIcon} aria-hidden="true">✓</div>
              <h3 className={styles.sentTitle}>Thanks — it is with us</h3>
              <p className={styles.sentBody}>
                We logged your {TYPES[sent.type].word} as <span className={styles.sentRef}>#{sent.ticketId}</span>.
              </p>
              <div className={styles.recap}>
                <p className={styles.recapType}>{TYPES[sent.type].label}</p>
                <p className={styles.recapSubject}>{sent.subject}</p>
              </div>
            </div>
          ) : (
            <form id="help-feedback-form" className={styles.form} onSubmit={handleSubmit}>
              <div className={styles.typeField}>
                <span className={styles.selectorLabel}>
                  What is this about
                  <span className={styles.required} aria-hidden="true">*</span>
                </span>
                <div
                  className={styles.typeGrid}
                  role="radiogroup"
                  aria-label="What is this about"
                  onKeyDown={handleTypeKeyDown}
                >
                  {TYPE_ORDER.map((key, i) => {
                    const t = TYPES[key]
                    const selected = type === key
                    return (
                      <button
                        key={key}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        tabIndex={selected ? 0 : -1}
                        disabled={submitting}
                        ref={(el) => { cardRefs.current[i] = el }}
                        className={`${styles.typeCard} ${selected ? styles.typeCardSelected : ''}`}
                        onClick={() => setType(key)}
                      >
                        <span className={styles.typeLabelRow}>
                          <span className={`${styles.typeDot} ${t.dotClass}`} aria-hidden="true" />
                          <span className={styles.typeLabel}>{t.label}</span>
                        </span>
                        <span className={styles.typeDesc}>{t.desc}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              <Field label="Subject" htmlFor="feedback-subject" required size="sm">
                <Input
                  id="feedback-subject"
                  ref={subjectRef}
                  inputSize="lg"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="One line — what happened, or what you need"
                  maxLength={200}
                  required
                  disabled={submitting}
                />
              </Field>

              <Field
                label="Details"
                htmlFor="feedback-details"
                required
                size="sm"
                labelAction={<span className={styles.counter} aria-hidden="true">{details.length} / {MAX_DETAILS}</span>}
              >
                <Textarea
                  id="feedback-details"
                  rows={5}
                  value={details}
                  onChange={(e) => setDetails(e.target.value.slice(0, MAX_DETAILS))}
                  placeholder={TYPES[type].placeholder}
                  aria-describedby="feedback-details-counter"
                  required
                  disabled={submitting}
                />
              </Field>
              {/* Visually hidden live region — separate from the visible
                  counter above, which is never aria-live (it would announce
                  on every keystroke). Only speaks up in the last 100 chars. */}
              <span id="feedback-details-counter" className={styles.srOnly} role="status" aria-live="polite">
                {remaining >= 0 && remaining <= 100 ? `${remaining} characters left` : ''}
              </span>
            </form>
          )}
        </div>

        {/* Outside the scroll area on purpose — a submit error must stay
            visible next to the button the user is about to press again. */}
        {error && !sent && <ErrorBanner tone="danger" className={styles.banner}>{error}</ErrorBanner>}

        <div className={styles.footer}>
          <p id="help-feedback-hint" className={styles.footerHint}>{hint}</p>
          <div className={`${styles.footerActions} ${sent ? styles.footerActionsSent : styles.footerActionsForm}`}>
            {sent ? (
              <>
                <Button variant="secondary" onClick={handleSendAnother}>Send another</Button>
                <Button variant="primary" onClick={handleClose}>Done</Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={handleClose}>Cancel</Button>
                <Button
                  type="submit"
                  form="help-feedback-form"
                  variant="primary"
                  disabled={!ready || submitting}
                  aria-describedby={hint ? 'help-feedback-hint' : undefined}
                >
                  {submitting ? 'Sending…' : 'Send'}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
