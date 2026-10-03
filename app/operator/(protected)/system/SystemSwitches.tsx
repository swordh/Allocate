'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Modal from '@/components/ui/Modal'
import Sheet from '@/components/ui/Sheet'
import Button from '@/components/ui/Button'
import Textarea from '@/components/ui/Textarea'
import ErrorBanner from '@/components/ui/ErrorBanner'
import { formatOperatorDateTime } from '@/lib/operatorDates'
import type { RegistrationFlags } from '@/lib/registrationFlags'
import { segmentTarget } from '@/lib/registrationSegment'
import { setRegistrationFlag, type RegistrationSwitch } from './actions'
import switchStyles from './SystemSwitches.module.css'

const MIN_REASON_LENGTH = 3
const MOBILE_QUERY = '(max-width: 768px)'

interface SwitchCopy {
  title: string
  noun: string
  openBody: string
  blockBody: string
}

// Copy is the design's, verbatim (Operator - System.dc.html GATES).
const COPY: Record<RegistrationSwitch, SwitchCopy> = {
  accounts: {
    title: 'New accounts',
    noun: 'account sign-ups',
    openBody: 'Anyone can create an account from the sign-up page.',
    blockBody:
      'The sign-up page says sign-ups are paused. Existing users log in as usual, and people invited to a company can still create their account through the invite. Server-side this only hides sign-up — block new companies as well to fully stop new customers.',
  },
  companies: {
    title: 'New companies',
    noun: 'company creation',
    openBody: 'Any logged-in user can create a new company.',
    blockBody:
      '"Create company" is disabled with a short notice. Existing companies, invitations and joining work as usual.',
  },
}

const ORDER: RegistrationSwitch[] = ['accounts', 'companies']

interface SystemSwitchesProps {
  flags: RegistrationFlags
}

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY)
    const sync = () => setIsMobile(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return isMobile
}

export default function SystemSwitches({ flags }: SystemSwitchesProps) {
  const router = useRouter()
  const isMobile = useIsMobile()

  // `target` is the value the clicked segment stands for (true = BLOCKED).
  const [pendingState, setPendingState] = useState<{ which: RegistrationSwitch; target: boolean } | null>(null)
  const pending = pendingState?.which ?? null
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const blockedOf = (which: RegistrationSwitch) =>
    which === 'accounts' ? flags.accountsBlocked : flags.companiesBlocked
  const sinceOf = (which: RegistrationSwitch) =>
    which === 'accounts' ? flags.accountsBlockedSince : flags.companiesBlockedSince

  function openConfirm(which: RegistrationSwitch, clicked: 'open' | 'blocked') {
    const target = segmentTarget(blockedOf(which), clicked)
    if (target === null) return // the active segment: nothing to change
    setPendingState({ which, target })
    setReason('')
    setError(null)
  }

  function close() {
    if (submitting) return
    setPendingState(null)
    setReason('')
    setError(null)
  }

  const willBlock = pendingState?.target ?? false
  const canCommit = reason.trim().length >= MIN_REASON_LENGTH && !submitting

  async function commit() {
    if (!pending || !canCommit) return
    setSubmitting(true)
    setError(null)
    const result = await setRegistrationFlag(pending, willBlock, reason)
    setSubmitting(false)
    if (result.error) {
      setError(result.error)
      return
    }
    setPendingState(null)
    setReason('')
    router.refresh()
  }

  const copy = pending ? COPY[pending] : null
  const tag = willBlock ? 'BLOCKS NEW USERS' : 'REOPENS'
  const title = copy ? `${willBlock ? 'Block' : 'Reopen'} ${copy.noun}?` : ''
  const body = copy
    ? willBlock
      ? `${copy.blockBody} It stays blocked until someone reopens it here.`
      : `${copy.openBody} The notice disappears immediately.`
    : ''
  const commitLabel = willBlock ? 'BLOCK' : 'REOPEN'
  const commitClass = [
    switchStyles.commit,
    canCommit ? (willBlock ? switchStyles.commitBlock : switchStyles.commitReopen) : '',
  ]
    .filter(Boolean)
    .join(' ')

  const fields = (helper: string) => (
    <>
      <p className={switchStyles.confirmBody}>{body}</p>
      <div className={switchStyles.reasonBlock}>
        <label className={switchStyles.reasonLabel} htmlFor="registration-reason">
          WHY — TICKET OR ONE SENTENCE
        </label>
        <Textarea
          id="registration-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={
            isMobile
              ? 'e.g. Spam sign-ups from one IP range'
              : 'e.g. Spam sign-ups from one IP range since 13:40'
          }
          maxLength={500}
          disabled={submitting}
          autoFocus={!isMobile}
        />
        <span className={switchStyles.reasonHelper}>{helper}</span>
      </div>
      {error && <ErrorBanner tone="danger">{error}</ErrorBanner>}
    </>
  )

  return (
    <>
      <section className={switchStyles.section}>
        <div className={switchStyles.sectionHead}>
          <span className={switchStyles.sectionLabel}>SIGN-UPS</span>
          <span className={switchStyles.sectionRule} />
        </div>

        {ORDER.map((which) => {
          const blocked = blockedOf(which)
          const since = sinceOf(which)
          return (
            <div
              key={which}
              className={`${switchStyles.card} ${blocked ? switchStyles.cardBlocked : ''}`}
              data-testid={`switch-${which}`}
            >
              <div className={switchStyles.cardTop}>
                <div className={switchStyles.cardHeading}>
                  <h2 className={switchStyles.cardTitle}>{COPY[which].title}</h2>
                  <span className={`${switchStyles.state} ${blocked ? switchStyles.stateBlocked : switchStyles.stateOpen}`}>
                    <span className={switchStyles.stateDot} />
                    {blocked
                      ? since
                        ? `BLOCKED SINCE ${formatOperatorDateTime(since)}`
                        : 'BLOCKED'
                      : 'OPEN'}
                  </span>
                </div>

                <div className={switchStyles.segments} role="group" aria-label={`${COPY[which].title} switch`}>
                  <button
                    type="button"
                    className={`${switchStyles.segment} ${!blocked ? switchStyles.segmentOpenActive : ''}`}
                    aria-pressed={!blocked}
                    onClick={() => openConfirm(which, 'open')}
                  >
                    OPEN
                  </button>
                  <button
                    type="button"
                    className={`${switchStyles.segment} ${blocked ? switchStyles.segmentBlockedActive : ''}`}
                    aria-pressed={blocked}
                    onClick={() => openConfirm(which, 'blocked')}
                  >
                    BLOCKED
                  </button>
                </div>
              </div>

              <p className={switchStyles.cardBody}>
                {blocked ? COPY[which].blockBody : COPY[which].openBody}
              </p>
            </div>
          )
        })}
      </section>

      {isMobile ? (
        <Sheet
          open={pending !== null}
          onClose={close}
          eyebrow={tag}
          title={title}
          dismissLabel="CANCEL ✕"
          className={`${switchStyles.sheetPanel} ${willBlock ? switchStyles.sheetBlocking : ''}`}
          footer={
            <div className={switchStyles.sheetFooter}>
              <Button variant="secondary" size="md" fullWidth onClick={close} disabled={submitting}>
                BACK
              </Button>
              <button type="button" className={commitClass} disabled={!canCommit} onClick={commit}>
                {commitLabel}
              </button>
            </div>
          }
        >
          <div className={switchStyles.sheetBody}>
            {fields('Saved with your name in the audit log. Takes effect immediately.')}
          </div>
        </Sheet>
      ) : (
        <Modal
          open={pending !== null}
          onClose={close}
          width={560}
          className={`${switchStyles.modalCard} ${willBlock ? switchStyles.modalBlocking : ''}`}
        >
          <div className={switchStyles.modalHeader}>
            <span className={`${switchStyles.tag} ${willBlock ? switchStyles.tagBlock : switchStyles.tagReopen}`}>
              {tag}
            </span>
            <button type="button" className={switchStyles.cancelLink} onClick={close}>
              CANCEL ✕
            </button>
          </div>
          <div className={switchStyles.modalContent}>
            <h2 className={switchStyles.confirmTitle}>{title}</h2>
            {fields('Saved with your name in the audit log. Required.')}
            <div className={switchStyles.modalFooter}>
              <span className={switchStyles.footerNote}>Takes effect immediately.</span>
              <Button variant="secondary" size="sm" onClick={close} disabled={submitting}>
                BACK
              </Button>
              <button type="button" className={commitClass} disabled={!canCommit} onClick={commit}>
                {commitLabel}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
