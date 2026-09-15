'use client'

import { useState, useTransition } from 'react'
import Chip from '@/components/ui/Chip'
import { formatDateFullInZone } from '@/lib/dates'
import { isStuckDeletion, nowMs, timeRemaining } from '@/lib/operatorDeletionView'
import { confirmationMatchesCompanyName } from '@/lib/companyDeletionUi'
import {
  cancelCompanyDeletionAsOperator,
  requestCompanyDeletionAsOperator,
  requeueFailedCompanyDeletion,
} from '@/actions/operatorCompanyDeletion'
import type { CompanyDeletionRow } from '@/types/operator'
import DeletionHistoryList from './DeletionHistoryList'
import styles from './deletion.module.css'

const ZONE = 'UTC' // see DeletionHistoryList's docblock for why UTC, not the company's own zone

interface DeletionSectionProps {
  companyId: string
  companyName: string
  rows: CompanyDeletionRow[]
  /** True when the companyDeletions read failed — must not render as "nothing on gång". */
  historyUnavailable: boolean
  /** Admins remaining in the company right now. Null when that read failed
   *  or is not applicable (company doc doesn't exist — handled by
   *  DeletedCompanyView instead, this section is only mounted for a company
   *  that still exists). */
  adminCount: number | null
}

/**
 * A note field shared by all three action forms below — deliberately plain
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
function CancelBlock({ companyId }: { companyId: string }) {
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
 * docblock for exactly what this resets (`state` and `attempts` only —
 * never `completedPhases`) and why.
 */
function RequeueBlock({ requestId }: { requestId: string }) {
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
 * "Radera på kundens begäran" — the one destructive-adjacent action here.
 * Requires the company's name typed exactly, same ritual as the customer's
 * own delete-company form (`confirmationMatchesCompanyName`), enforced for
 * real on the server (this client-side check is only what enables the
 * button, exactly like `CompanySettingsForm`'s own use of the same helper —
 * see that helper's docblock in lib/companyDeletionUi.ts).
 */
function RequestDeletionBlock({ companyId, companyName }: { companyId: string; companyName: string }) {
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

export default function DeletionSection({ companyId, companyName, rows, historyUnavailable, adminCount }: DeletionSectionProps) {
  const now = nowMs()
  const latest = rows[0]
  const isActive = latest && (latest.state === 'requested' || latest.state === 'executing' || latest.state === 'failed')
  const stuck = latest ? isStuckDeletion(latest, now) : false
  const remaining = latest && latest.state === 'requested' ? timeRemaining(latest.scheduledFor, now) : null
  const noAdminsLeft = isActive && latest.state === 'requested' && adminCount === 0

  return (
    <div className={styles.deletionSection}>
      <span className={styles.sectionLabel}>COMPANY DELETION</span>

      {historyUnavailable ? (
        <div className={styles.statusCallout}>
          <span className={styles.metaLine}>Deletion history could not be loaded right now.</span>
        </div>
      ) : !isActive ? (
        <div className={styles.statusCallout}>
          <Chip size="tag" interactive={false} tone="neutral">NOTHING PENDING</Chip>
          <span className={styles.metaLine}>
            {rows.length > 0 ? 'No deletion is currently in progress — see history below.' : 'No deletion has ever been requested for this company.'}
          </span>
        </div>
      ) : (
        <div className={`${styles.statusCallout} ${styles.statusCalloutDanger}`}>
          <Chip size="tag" interactive={false} tone="danger">
            {latest.state === 'requested' ? 'DELETION REQUESTED' : latest.state === 'executing' ? 'EXECUTING' : 'FAILED'}
          </Chip>
          {stuck && <Chip size="tag" interactive={false} tone="danger">STUCK</Chip>}
          {latest.state === 'requested' && remaining && (
            <span className={styles.remaining}>
              Scheduled for {formatDateFullInZone(latest.scheduledFor, ZONE)} — {remaining.label}
            </span>
          )}
          {latest.state !== 'requested' && (
            <span className={styles.metaLine}>Cannot be stopped from the customer&apos;s own product surfaces any more.</span>
          )}
        </div>
      )}

      {noAdminsLeft && (
        <div className={styles.noAdminsNotice}>
          No administrators remain in this company — only support can stop this deletion.
        </div>
      )}
      {isActive && latest.state === 'requested' && adminCount !== null && adminCount > 0 && (
        <span className={styles.metaLine}>
          {adminCount} administrator{adminCount === 1 ? '' : 's'} remaining — any of them can cancel this from the product.
        </span>
      )}
      {isActive && latest.state === 'requested' && adminCount === null && (
        <span className={styles.metaLine}>Administrator count could not be read right now.</span>
      )}

      {/* Operator actions — issue #252 step 6, PR 5. Never shown when the
          history read itself failed: acting on a stale or unknown state
          would be exactly the "osant påstående" this PR is warned against. */}
      {!historyUnavailable && isActive && latest.state === 'requested' && <CancelBlock companyId={companyId} />}
      {!historyUnavailable && isActive && latest.state === 'failed' && <RequeueBlock requestId={latest.requestId} />}
      {!historyUnavailable && !isActive && <RequestDeletionBlock companyId={companyId} companyName={companyName} />}

      <span className={styles.sectionLabelSmall}>HISTORY</span>
      {historyUnavailable ? (
        <span className={styles.metaLine}>History unavailable right now.</span>
      ) : (
        <DeletionHistoryList
          rows={rows}
          emptyHeading="No deletion history"
          emptyBody="This company has never had a deletion requested."
        />
      )}
    </div>
  )
}
