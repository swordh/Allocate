'use client'

import { useState, useTransition } from 'react'
import { confirmationMatchesCompanyName } from '@/lib/companyDeletionUi'
import {
  cancelCompanyDeletionAsOperator,
  requestCompanyDeletionAsOperator,
  requeueFailedCompanyDeletion,
  markStuckCompanyDeletionFailed,
} from '@/actions/operatorCompanyDeletion'
import styles from './deletion.module.css'

/**
 * The operator view's write-action forms (issue #252 step 6, PR 5; issue
 * #331/#335 added `MarkFailedBlock`). Extracted out of `DeletionSection.tsx`
 * so `DeletedCompanyView.tsx` can render `RequeueBlock`/`MarkFailedBlock` too
 * — a purge can fail (or get stuck) AFTER `companies/{companyId}` itself is
 * already gone (a crash between `runFinalizePhase`'s company-doc delete and
 * its `state: 'completed'` write — see that function's own idempotency
 * notes in functions/src/company/purge.ts), so those two actions are not
 * exclusively a "the company still exists" concern the way
 * `CancelBlock`/`RequestDeletionBlock` are.
 */

/**
 * A note field shared by every action form below — deliberately plain
 * text, no required-field enforcement client-side. The server actions
 * (actions/operatorCompanyDeletion.ts) treat the note as optional; this is
 * "kan förses med en notering", not "måste". The one thing that is NEVER
 * optional is the actor identity, which the server derives from the
 * operator's own session — nothing typed here can substitute for or spoof
 * that.
 */
function NoteField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <input
      type="text"
      className={styles.actionNote}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  )
}

/**
 * "Avbryta" — the safe action. Only rendered while `latest.state ===
 * 'requested'` (checked by the caller): once a purge has actually started,
 * cancelling can no longer honestly claim the company is untouched — see the
 * long docblock on `cancelCompanyDeletionAsOperator` in
 * actions/operatorCompanyDeletion.ts. No typed confirmation here on purpose —
 * this is the one action in this file that is supposed to be easy.
 */
export function CancelBlock({ companyId }: { companyId: string }) {
  const [note, setNote] = useState('')
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<{ ok?: boolean; error?: string } | null>(null)

  function handleCancel() {
    setResult(null)
    startTransition(async () => {
      const res = await cancelCompanyDeletionAsOperator(companyId, note)
      if (res.error) setResult({ error: res.error })
      else {
        setResult({ ok: true })
        setNote('')
      }
    })
  }

  return (
    <div className={styles.actionBlock}>
      <span className={styles.sectionLabelSmall}>CANCEL THIS DELETION</span>
      <div className={styles.actionRow}>
        <NoteField value={note} onChange={setNote} placeholder="Reason / ticket ref (optional)" />
        <button type="button" className={styles.actionButton} onClick={handleCancel} disabled={pending}>
          {pending ? 'CANCELLING…' : 'CANCEL DELETION'}
        </button>
      </div>
      {result?.error && <span className={styles.actionError}>{result.error}</span>}
      {result?.ok && <span className={styles.actionSuccess}>Cancelled.</span>}
    </div>
  )
}

/**
 * "Kör om" — resumes a `failed` purge from where it stopped. Only rendered
 * while `latest.state === 'failed'`. See `requeueFailedCompanyDeletion`'s
 * docblock for exactly what this resets (`state`, `attempts`, and the
 * no-progress baselines — never `completedPhases`) and why, and for the new
 * `contactsRedactedAt` guard that can refuse this outright.
 */
export function RequeueBlock({ requestId }: { requestId: string }) {
  const [note, setNote] = useState('')
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<{ ok?: boolean; error?: string } | null>(null)

  function handleRequeue() {
    setResult(null)
    startTransition(async () => {
      const res = await requeueFailedCompanyDeletion(requestId, note)
      if (res.error) setResult({ error: res.error })
      else {
        setResult({ ok: true })
        setNote('')
      }
    })
  }

  return (
    <div className={styles.actionBlock}>
      <span className={styles.sectionLabelSmall}>REQUEUE THIS PURGE</span>
      <div className={styles.actionRow}>
        <NoteField value={note} onChange={setNote} placeholder="Reason / ticket ref (optional)" />
        <button type="button" className={styles.actionButton} onClick={handleRequeue} disabled={pending}>
          {pending ? 'REQUEUING…' : 'REQUEUE'}
        </button>
      </div>
      <span className={styles.metaLine}>
        Resumes from the last completed phase — does not start over. Picked up by the sweep within about 30 minutes.
      </span>
      {result?.error && <span className={styles.actionError}>{result.error}</span>}
      {result?.ok && <span className={styles.actionSuccess}>Requeued.</span>}
    </div>
  )
}

/**
 * "Markera som misslyckad" — issue #335's operator move for a purge that is
 * `executing` but visibly stuck (a phase that SIGKILLs on every invocation
 * never increments `attempts`, so it never reaches `failed` on its own — see
 * `markStuckCompanyDeletionFailed`'s docblock). Only rendered while
 * `latest.state === 'executing' && stuck` (checked by the caller, using the
 * SAME `isStuckDeletion` bar this row's own STUCK chip uses).
 *
 * A CONFIRM STEP, unlike Cancel/Requeue: this is the one action here that can
 * fire mid-flight of a purge that is not actually dead, only slow (a huge
 * `bookings` subtree, say) — the heartbeat-staleness guard on the server
 * catches that too, but a confirm step in front of a support-facing action
 * that stops automatic retries and mails the company's admins is the design
 * brief's own bar for "en medveten handling", one notch below the typed-name
 * ritual `RequestDeletionBlock` uses for something genuinely irreversible-
 * adjacent.
 */
export function MarkFailedBlock({ requestId }: { requestId: string }) {
  const [note, setNote] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<{ ok?: boolean; error?: string } | null>(null)

  function handleConfirm() {
    setResult(null)
    startTransition(async () => {
      const res = await markStuckCompanyDeletionFailed(requestId, note)
      if (res.error) setResult({ error: res.error })
      else {
        setResult({ ok: true })
        setNote('')
      }
      setConfirming(false)
    })
  }

  return (
    <div className={styles.actionBlock}>
      <span className={styles.sectionLabelSmall}>MARK THIS PURGE AS FAILED</span>
      <span className={styles.metaLine}>
        Stops automatic retries and notifies the company&apos;s admins. You can then requeue it.
      </span>
      {!confirming ? (
        <div className={styles.actionRow}>
          <NoteField value={note} onChange={setNote} placeholder="Reason / ticket ref (optional)" />
          <button type="button" className={styles.actionButtonDanger} onClick={() => setConfirming(true)} disabled={pending}>
            MARK AS FAILED
          </button>
        </div>
      ) : (
        <div className={styles.actionRow}>
          <span className={styles.metaLine}>Are you sure? This notifies the company&apos;s admins.</span>
          <button type="button" className={styles.actionButtonDanger} onClick={handleConfirm} disabled={pending}>
            {pending ? 'MARKING…' : 'CONFIRM'}
          </button>
          <button type="button" className={styles.actionButton} onClick={() => setConfirming(false)} disabled={pending}>
            CANCEL
          </button>
        </div>
      )}
      {result?.error && <span className={styles.actionError}>{result.error}</span>}
      {result?.ok && <span className={styles.actionSuccess}>Marked as failed.</span>}
    </div>
  )
}

/**
 * "Radera på kundens begäran" — the one destructive-adjacent action here.
 * Requires the company's name typed exactly, same ritual as the customer's
 * own delete-company form (`confirmationMatchesCompanyName`), enforced for
 * real on the server (this client-side check is only what enables the
 * button, exactly like `CompanySettingsForm`'s own use of the same helper —
 * see that helper's docblock in lib/companyDeletionUi.ts).
 */
export function RequestDeletionBlock({ companyId, companyName }: { companyId: string; companyName: string }) {
  const [confirmText, setConfirmText] = useState('')
  const [note, setNote] = useState('')
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<{ ok?: boolean; error?: string } | null>(null)

  const canSubmit = confirmationMatchesCompanyName(confirmText, companyName)

  function handleRequest() {
    if (!canSubmit) return
    setResult(null)
    startTransition(async () => {
      const res = await requestCompanyDeletionAsOperator(companyId, confirmText, note)
      if (res.error) setResult({ error: res.error })
      else {
        setResult({ ok: true })
        setConfirmText('')
        setNote('')
      }
    })
  }

  return (
    <div className={styles.actionBlock}>
      <span className={styles.sectionLabelSmall}>DELETE THIS COMPANY ON THE CUSTOMER&apos;S BEHALF</span>
      <span className={styles.metaLine}>
        Starts the same seven-day window the customer&apos;s own admin would get. Type the company name exactly to confirm: <strong>{companyName}</strong>
      </span>
      <div className={styles.actionRow}>
        <input
          type="text"
          className={styles.actionNote}
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="Type the company name to confirm"
        />
        <NoteField value={note} onChange={setNote} placeholder="Reason / ticket ref (optional)" />
        <button
          type="button"
          className={styles.actionButtonDanger}
          onClick={handleRequest}
          disabled={pending || !canSubmit}
        >
          {pending ? 'STARTING…' : 'START DELETION'}
        </button>
      </div>
      {result?.error && <span className={styles.actionError}>{result.error}</span>}
      {result?.ok && <span className={styles.actionSuccess}>Deletion window started.</span>}
    </div>
  )
}
