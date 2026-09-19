'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { leaveCompany, updateMemberRole } from '@/actions/team'
import { requestCompanyDeletion } from '@/actions/companyDeletion'
import { confirmationMatchesCompanyName } from '@/lib/companyDeletionUi'
import { deleteSession } from '@/actions/auth'
import { establishSessionFromCustomToken, useCompanySwitch } from '@/lib/useCompanySwitch'
import Modal from '@/components/ui/Modal'
import FullScreenSheet from '@/components/ui/FullScreenSheet'
import CompanySwitchOverlay from '@/components/ui/CompanySwitchOverlay'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import Checkbox from '@/components/ui/Checkbox'
import ErrorBanner from '@/components/ui/ErrorBanner'
import MemberPicker, { type PromotableMember } from './MemberPicker'
import LeaveCompanyReceipt from './LeaveCompanyReceipt'
import styles from './LeaveCompanyFlow.module.css'

type Step = 'consequences' | 'blocked' | 'close' | 'closeScheduled' | 'receipt'

interface LeaveCompanyFlowProps {
  onClose: () => void
  companyId: string
  companyName: string
  /** Whether `companyId` is the caller's currently active company — decides
   *  both how the sole-admin-blocked case can be resolved (promoting
   *  requires being IN the company; see `updateMemberRole`'s own
   *  session.activeCompanyId scoping) and what CONTINUE does on the receipt. */
  isActiveCompany: boolean
}

const MOBILE_QUERY = '(max-width: 768px)'

/**
 * Orchestrates issue #352's leave-company flow: the consequences/checkbox
 * gate, the sole-admin-blocked promote picker, the sole-member routing into
 * the existing company-deletion confirm, and the result receipt. Desktop
 * renders inside `Modal`, mobile inside `FullScreenSheet` — same
 * `matchMedia` breakpoint switch `Sheet.tsx` already uses.
 *
 * Always considered "open" while mounted — no `open` prop. The caller
 * conditionally mounts it (`{leaving && <LeaveCompanyFlow key={leaving.id} .../>}`)
 * so opening it for a (possibly different) company always starts from a
 * fresh mount, which is what actually resets all of this component's step
 * state — an effect keyed on an `open` prop toggling would just be doing
 * manually what a fresh mount already does for free.
 */
export default function LeaveCompanyFlow({
  onClose,
  companyId,
  companyName,
  isActiveCompany,
}: LeaveCompanyFlowProps) {
  const router = useRouter()
  const [isMobile, setIsMobile] = useState(false)
  const [step, setStep] = useState<Step>('consequences')
  const [checked, setChecked] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [promotable, setPromotable] = useState<PromotableMember[]>([])
  const [selectedPromotee, setSelectedPromotee] = useState<string | null>(null)
  const [promoting, setPromoting] = useState(false)
  const [promotedName, setPromotedName] = useState<string | null>(null)
  const [hadOtherMemberships, setHadOtherMemberships] = useState(true)
  const [closeConfirmInput, setCloseConfirmInput] = useState('')
  const [closeSubmitting, setCloseSubmitting] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)
  const { switchTo } = useCompanySwitch()

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY)
    const sync = () => setIsMobile(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  async function handleLeave() {
    setSubmitting(true)
    setError(null)

    const result = await leaveCompany(companyId)

    if (result.error) {
      setError(result.error)
      setSubmitting(false)
      return
    }

    if (result.blocked) {
      setPromotable(result.blocked.promotable)
      setStep('blocked')
      setSubmitting(false)
      return
    }

    if (result.onlyMember) {
      setStep('close')
      setSubmitting(false)
      return
    }

    if (result.left) {
      if (result.left.sessionRefresh) {
        setSwitching(true)
        try {
          await establishSessionFromCustomToken(result.left.sessionRefresh.customToken)
        } catch {
          // Membership is already gone server-side regardless of whether the
          // client could re-establish a session — send her to sign in again
          // rather than strand her on a broken one.
          window.location.href = '/login'
          return
        }
        setSwitching(false)
        setHadOtherMemberships(result.left.sessionRefresh.redirectCompanyId !== null)
      } else {
        setHadOtherMemberships(true)
      }
      setStep('receipt')
    }

    setSubmitting(false)
  }

  async function handlePromote() {
    if (!selectedPromotee) return
    setPromoting(true)
    setError(null)

    const result = await updateMemberRole(selectedPromotee, 'admin')

    setPromoting(false)

    if (result.error) {
      setError(result.error)
      return
    }

    setPromotedName(promotable.find((m) => m.uid === selectedPromotee)?.name ?? null)
    setStep('consequences')
  }

  async function handleScheduleDeletion() {
    setCloseSubmitting(true)
    setCloseError(null)

    const result = await requestCompanyDeletion(closeConfirmInput)

    setCloseSubmitting(false)

    if (result.error) {
      setCloseError(result.error)
      return
    }

    setStep('closeScheduled')
  }

  function handleContinue() {
    if (isActiveCompany) {
      window.location.href = '/'
    } else {
      onClose()
      router.refresh()
    }
  }

  async function handleSignOut() {
    await deleteSession()
    router.push('/login')
  }

  function handleSwitchThenLeave() {
    onClose()
    void switchTo(companyId)
  }

  if (switching) {
    return <CompanySwitchOverlay targetCompanyName={companyName} />
  }

  let title: string | undefined
  let body: ReactNode
  let footer: ReactNode

  if (step === 'receipt') {
    title = undefined
    body = (
      <LeaveCompanyReceipt
        companyName={companyName}
        hadOtherMemberships={hadOtherMemberships}
        onContinue={handleContinue}
        onSignOut={handleSignOut}
      />
    )
    footer = null
  } else if (step === 'blocked') {
    title = "You're the only administrator"
    if (isActiveCompany) {
      body = (
        <div className={styles.stack}>
          <p className={styles.lead}>
            {companyName} would be left without anyone who can manage members, equipment and billing.
            Make someone else an administrator, then you can leave.
          </p>
          <MemberPicker
            name="promote-admin"
            members={promotable}
            selected={selectedPromotee}
            onSelect={setSelectedPromotee}
          />
          {error && <ErrorBanner tone="danger">{error}</ErrorBanner>}
        </div>
      )
      footer = (
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={promoting}>
            CLOSE
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handlePromote}
            disabled={!selectedPromotee || promoting}
          >
            {promoting ? 'PROMOTING…' : 'MAKE ADMIN & CONTINUE'}
          </Button>
        </>
      )
    } else {
      body = (
        <p className={styles.lead}>
          You&apos;re the only administrator of {companyName}. Switch to it first, then promote another
          member from Team settings before you can leave.
        </p>
      )
      footer = (
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            CLOSE
          </Button>
          <Button variant="primary" size="sm" onClick={handleSwitchThenLeave}>
            SWITCH TO {companyName.toUpperCase()}
          </Button>
        </>
      )
    }
  } else if (step === 'close') {
    title = 'Nobody to leave it to'
    const confirmDisabled = closeSubmitting || !confirmationMatchesCompanyName(closeConfirmInput, companyName)
    body = (
      <div className={styles.stack}>
        <p className={styles.lead}>
          There is nobody to leave {companyName} to — you&apos;re its only member. Leaving means closing
          the company, which follows the same seven-day window as deleting it from Settings → Company: it
          keeps working until then, and any administrator (you) can stop it.
        </p>
        <Input
          value={closeConfirmInput}
          onChange={(e) => {
            setCloseConfirmInput(e.target.value)
            setCloseError(null)
          }}
          placeholder={companyName}
        />
        {closeError && <ErrorBanner tone="danger">{closeError}</ErrorBanner>}
      </div>
    )
    footer = (
      <>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={closeSubmitting}>
          KEEP IT
        </Button>
        <Button variant="danger-solid" size="sm" onClick={handleScheduleDeletion} disabled={confirmDisabled}>
          {closeSubmitting ? 'SCHEDULING…' : 'SCHEDULE DELETION'}
        </Button>
      </>
    )
  } else if (step === 'closeScheduled') {
    title = `${companyName} is set to be deleted`
    body = (
      <p className={styles.lead}>
        You remain a member until then, and everything keeps working as usual. Any administrator can cancel
        from Settings → Company before the window runs out.
      </p>
    )
    footer = (
      <Button variant="primary" size="sm" onClick={onClose}>
        DONE
      </Button>
    )
  } else {
    title = `Leaving ${companyName}`
    body = (
      <div className={styles.stack}>
        {promotedName && (
          <ErrorBanner tone="info">
            {promotedName} is now an administrator at {companyName}. Nothing is blocking you.
          </ErrorBanner>
        )}
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt>Access</dt>
            <dd>You lose access to its bookings and equipment at once.</dd>
          </div>
          <div className={styles.fact}>
            <dt>Your bookings</dt>
            <dd>Stay in the company, anonymised — your name comes off them.</dd>
          </div>
          <div className={styles.fact}>
            <dt>Coming back</dt>
            <dd>Only a new invitation from an administrator at {companyName}.</dd>
          </div>
          <div className={styles.fact}>
            <dt>Receipt</dt>
            <dd>A confirmation email is sent to you.</dd>
          </div>
        </dl>
        <Checkbox
          checked={checked}
          onChange={setChecked}
          label={`I understand that only an administrator at ${companyName} can let me back in, with a new invitation.`}
        />
        {error && <ErrorBanner tone="danger">{error}</ErrorBanner>}
      </div>
    )
    footer = (
      <>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
          STAY A MEMBER
        </Button>
        <Button variant="danger-solid" size="sm" onClick={handleLeave} disabled={!checked || submitting}>
          {submitting ? 'LEAVING…' : `LEAVE ${companyName.toUpperCase()}`}
        </Button>
      </>
    )
  }

  if (isMobile) {
    return (
      <FullScreenSheet open onClose={step === 'receipt' ? undefined : onClose} footer={footer}>
        {title && <h2 className={styles.mobileTitle}>{title}</h2>}
        {body}
      </FullScreenSheet>
    )
  }

  return (
    <Modal open onClose={onClose} title={title} width={760} footer={footer}>
      {body}
    </Modal>
  )
}
