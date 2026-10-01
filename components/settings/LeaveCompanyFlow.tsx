'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { leaveCompany, updateMemberRole } from '@/actions/team'
import { getLeaveContext, type PromotableMember } from '@/actions/companies'
import { requestCompanyDeletion } from '@/actions/companyDeletion'
import { confirmationMatchesCompanyName } from '@/lib/companyDeletionUi'
import { deleteSession } from '@/actions/auth'
import { establishSessionFromCustomToken, useCompanySwitch } from '@/lib/useCompanySwitch'
import type { DeletionOutcome } from '@/lib/queries/deletionOutcomes'
import Modal from '@/components/ui/Modal'
import FullScreenSheet from '@/components/ui/FullScreenSheet'
import CompanySwitchOverlay from '@/components/ui/CompanySwitchOverlay'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import Chip from '@/components/ui/Chip'
import Checkbox from '@/components/ui/Checkbox'
import ErrorBanner from '@/components/ui/ErrorBanner'
import LeaveFacts, { type LeaveFact } from './LeaveFacts'
import MemberPicker from './MemberPicker'
import LeaveCompanyReceipt from './LeaveCompanyReceipt'
import styles from './LeaveCompanyFlow.module.css'

type Step = 'consequences' | 'blocked' | 'closeOverview' | 'closeConfirm' | 'closeScheduled' | 'receipt'

interface LeaveCompanyFlowProps {
  onClose: () => void
  companyId: string
  companyName: string
  /** Whether `companyId` is the caller's currently active company — decides
   *  both how the sole-admin-blocked case can be resolved (promoting
   *  requires being IN the company; see `updateMemberRole`'s own
   *  session.activeCompanyId scoping) and what CONTINUE does on the receipt. */
  isActiveCompany: boolean
  /** The caller's own address — the RECEIPT lines name it. */
  email: string
  /** Advisory reading from `getDeletionOutcomes`; decides which step the flow
   *  opens on. `leaveCompany` re-decides for real when the user acts. */
  outcome: DeletionOutcome
  /** Total members including the caller, for the blocked lead copy. */
  memberCount: number
}

const MOBILE_QUERY = '(max-width: 768px)'
/** Matches `WINDOW_MS` in actions/companyDeletion.ts — shown before the
 *  server has scheduled anything, so the two must agree. */
const WINDOW_DAYS = 7

function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000)
}

function formatLong(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

/** "20 SEP 2026". Built by hand rather than via `toLocaleDateString`, whose
 *  en-GB short month renders September as "Sept" — the odd one out against
 *  every other three-letter month in the design. */
const SHORT_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

function formatShortUpper(date: Date): string {
  return `${date.getDate()} ${SHORT_MONTHS[date.getMonth()]} ${date.getFullYear()}`
}

function initialStep(outcome: DeletionOutcome): Step {
  if (outcome === 'blocked') return 'blocked'
  if (outcome === 'close') return 'closeOverview'
  return 'consequences'
}

/**
 * Orchestrates issue #352's leave-company flow: the consequences/checkbox
 * gate, the sole-admin-blocked successor picker, the sole-member routing into
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
  email,
  outcome,
  memberCount,
}: LeaveCompanyFlowProps) {
  const router = useRouter()
  const [isMobile, setIsMobile] = useState(false)
  const [step, setStep] = useState<Step>(() => initialStep(outcome))
  const [checked, setChecked] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bookingCount, setBookingCount] = useState(0)
  const [promotable, setPromotable] = useState<PromotableMember[]>([])
  const [selectedPromotee, setSelectedPromotee] = useState<string | null>(null)
  const [promoting, setPromoting] = useState(false)
  const [promotedName, setPromotedName] = useState<string | null>(null)
  const [hadOtherMemberships, setHadOtherMemberships] = useState(true)
  const [closeConfirmInput, setCloseConfirmInput] = useState('')
  const [closeSubmitting, setCloseSubmitting] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)
  const [scheduledForIso, setScheduledForIso] = useState<string | null>(null)
  const { switchTo } = useCompanySwitch()

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY)
    const sync = () => setIsMobile(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  // Booking count + successor list. Read-only, and advisory in the same sense
  // the outcome above is: nothing here gates a write, it only fills in the
  // numbers and names the copy quotes.
  useEffect(() => {
    let cancelled = false
    getLeaveContext(companyId)
      .then((ctx) => {
        if (cancelled) return
        setBookingCount(ctx.bookingCount)
        setPromotable(ctx.promotable)
      })
      .catch(() => {
        /* Leaves the generic, number-free copy in place. */
      })
    return () => { cancelled = true }
  }, [companyId])

  // Before the server has scheduled anything this is the date the window
  // WOULD land on; afterwards it's the one the ledger actually recorded.
  const scheduledFor = scheduledForIso ? new Date(scheduledForIso) : addDays(new Date(), WINDOW_DAYS)

  async function handleLeave() {
    setSubmitting(true)
    setError(null)

    const result = await leaveCompany(companyId)

    if (result.error) {
      setError(result.error)
      setSubmitting(false)
      return
    }

    // The advisory outcome this flow opened on can be stale — the server is
    // what actually decides, so both re-routes are still reachable here.
    if (result.blocked) {
      setPromotable(result.blocked.promotable)
      setStep('blocked')
      setSubmitting(false)
      return
    }

    if (result.onlyMember) {
      setStep('closeOverview')
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

    setScheduledForIso(result.scheduledFor ?? null)
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

  if (step === 'receipt') {
    return (
      <LeaveCompanyReceipt
        companyName={companyName}
        hadOtherMemberships={hadOtherMemberships}
        email={email}
        bookingCount={bookingCount}
        onContinue={handleContinue}
        onSignOut={handleSignOut}
      />
    )
  }

  const deletionFacts: LeaveFact[] = [
    {
      label: 'Billing',
      value:
        'No charge during the seven days — no renewal, no trial converting. Stop the deletion and the same plan resumes as if nothing happened.',
    },
    { label: 'No refund', value: 'Paid time you have left is not refunded when the company is deleted.', tone: 'danger' },
    { label: 'Your account', value: 'Your Allocate account stays. Only the company goes.' },
    { label: 'Receipt', value: `A confirmation with the stop link goes to ${email}.` },
  ]

  let meta: string
  let content: ReactNode
  let footerNote: string | null = null
  let actions: ReactNode

  if (step === 'blocked') {
    meta = 'Leave company · cannot continue yet'
    const othersLeftBehind = Math.max(memberCount - 1, 0)

    if (isActiveCompany) {
      content = (
        <>
          <Chip size="tag" tone="accent" interactive={false}>
            Blocked
          </Chip>
          <h2 className={styles.title}>You are the only administrator at {companyName}</h2>
          <p className={styles.lead}>
            {othersLeftBehind} other {othersLeftBehind === 1 ? 'member stays' : 'members stay'} behind, and
            somebody has to be able to manage equipment, invite people and handle billing. Make one of them an
            administrator and you can leave straight away.
          </p>
          <p className={styles.sectionLabel}>Choose the next administrator</p>
          <MemberPicker
            name="promote-admin"
            members={promotable}
            selected={selectedPromotee}
            onSelect={setSelectedPromotee}
          />
          <div className={styles.alternative}>
            <p className={styles.alternativeText}>
              Should {companyName} not continue at all? Then it is the company that goes, not your membership.
            </p>
            <Button variant="quiet" size="sm" href="/settings/company">
              DELETE THE COMPANY →
            </Button>
          </div>
          {error && <ErrorBanner tone="danger">{error}</ErrorBanner>}
        </>
      )
      footerNote = 'Pick one person to take over.'
      actions = (
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={promoting}>
            STAY FOR NOW
          </Button>
          <Button variant="primary" size="sm" onClick={handlePromote} disabled={!selectedPromotee || promoting}>
            {promoting ? 'PROMOTING…' : 'MAKE ADMIN & CONTINUE'}
          </Button>
        </>
      )
    } else {
      content = (
        <>
          <Chip size="tag" tone="accent" interactive={false}>
            Blocked
          </Chip>
          <h2 className={styles.title}>You are the only administrator at {companyName}</h2>
          <p className={styles.lead}>
            Handing the role over happens inside {companyName}. Switch to it first, then promote another member
            from Team settings — after that you can leave.
          </p>
        </>
      )
      actions = (
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            STAY FOR NOW
          </Button>
          <Button variant="primary" size="sm" onClick={handleSwitchThenLeave}>
            SWITCH TO {companyName.toUpperCase()}
          </Button>
        </>
      )
    }
  } else if (step === 'closeOverview') {
    meta = 'Leave company · ends the company · 1 of 2'
    content = (
      <>
        <h2 className={styles.title}>There is nobody to leave {companyName} to</h2>
        <p className={styles.lead}>
          You are its only member. Stepping out means the company ends — so this is the ordinary company
          deletion, with the same seven days and the same terms.
        </p>
        <div className={styles.timeline}>
          <div className={`${styles.phase} ${styles.phaseNow}`}>
            <p className={`${styles.phaseLabel} ${styles.phaseLabelNow}`}>Today</p>
            <p className={styles.phaseTitle}>You confirm</p>
            <p className={styles.phaseBody}>The end date is set. You stay a member and everything keeps working.</p>
          </div>
          <div className={styles.phase}>
            <p className={styles.phaseLabel}>Day 1–7</p>
            <p className={styles.phaseTitle}>You can stop it</p>
            <p className={styles.phaseBody}>
              One click in Settings or in the mail brings the company back to normal.
            </p>
          </div>
          <div className={`${styles.phase} ${styles.phaseEnd}`}>
            <p className={`${styles.phaseLabel} ${styles.phaseLabelEnd}`}>{formatLong(scheduledFor).toUpperCase()}</p>
            <p className={styles.phaseTitle}>Everything is gone</p>
            <p className={styles.phaseBody}>Bookings, equipment and the company itself. Nobody can restore it.</p>
          </div>
        </div>
        <LeaveFacts facts={deletionFacts} />
      </>
    )
    footerNote = 'Continuing leads to one confirmation. Nothing is scheduled before that.'
    actions = (
      <>
        <Button variant="secondary" size="sm" onClick={onClose}>
          KEEP THE COMPANY
        </Button>
        <Button variant="primary" size="sm" onClick={() => setStep('closeConfirm')}>
          CONTINUE
        </Button>
      </>
    )
  } else if (step === 'closeConfirm') {
    meta = 'Leave company · ends the company · 2 of 2'
    const confirmDisabled = closeSubmitting || !confirmationMatchesCompanyName(closeConfirmInput, companyName)
    content = (
      <>
        <button type="button" className={styles.back} onClick={() => setStep('closeOverview')}>
          ← BACK
        </button>
        <h2 className={styles.title}>Start the seven-day deletion</h2>
        <p className={styles.lead}>
          On {formatLong(scheduledFor)} {companyName} and everything in it is gone for good. Until then you can
          stop it from Settings or from the mail we send you.
        </p>
        <div className={styles.confirmBox}>
          <p className={styles.confirmLabel}>Type the company name to confirm: {companyName}</p>
          <Input
            value={closeConfirmInput}
            onChange={(e) => {
              setCloseConfirmInput(e.target.value)
              setCloseError(null)
            }}
            placeholder={companyName}
          />
        </div>
        {closeError && <ErrorBanner tone="danger">{closeError}</ErrorBanner>}
      </>
    )
    footerNote = 'Remaining paid time is not refunded.'
    actions = (
      <>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={closeSubmitting}>
          KEEP THE COMPANY
        </Button>
        <Button variant="danger-solid" size="sm" onClick={handleScheduleDeletion} disabled={confirmDisabled}>
          {closeSubmitting ? 'SCHEDULING…' : 'SCHEDULE DELETION'}
        </Button>
      </>
    )
  } else if (step === 'closeScheduled') {
    meta = 'Deletion scheduled'
    content = (
      <>
        <p className={styles.confirmedEyebrow}>Scheduled · today {formatShortUpper(new Date())}</p>
        <h2 className={styles.title}>
          {companyName} is set to be deleted on {formatLong(scheduledFor)}
        </h2>
        <p className={styles.lead}>
          You are still a member until then, and everything works as usual. Change your mind and you stop it
          with one click.
        </p>
        <LeaveFacts facts={deletionFacts} />
        <div className={styles.inlineAction}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              onClose()
              router.refresh()
            }}
          >
            BACK TO SETTINGS
          </Button>
        </div>
      </>
    )
  } else {
    meta = 'Leave company · 1 of 1'
    content = (
      <>
        {promotedName && (
          <p className={styles.handover}>
            {promotedName} is now an administrator at {companyName}. Nothing is blocking you.
          </p>
        )}
        <h2 className={styles.title}>Leaving {companyName}</h2>
        <p className={styles.lead}>
          You keep your Allocate account and everything you do in your other companies. This only ends your
          membership here.
        </p>
        <LeaveFacts
          facts={[
            { label: 'Access', value: `You will lose access to all bookings and equipment for ${companyName}.`, tone: 'danger' },
            {
              label: 'Your bookings',
              value: bookingCount > 0
                ? `The ${bookingCount} bookings you made stay in ${companyName}'s history for the team, with your name removed.`
                : `The bookings you made stay in ${companyName}'s history for the team, with your name removed.`,
            },
            { label: 'Coming back', value: `Only an administrator at ${companyName} can let you back in, with a new invitation.` },
            { label: 'Receipt', value: `A confirmation goes to ${email}.` },
          ]}
        />
        <div className={styles.gate}>
          <Checkbox
            checked={checked}
            onChange={setChecked}
            label={`I understand that only an administrator at ${companyName} can let me back in, with a new invitation.`}
          />
        </div>
        {error && <ErrorBanner tone="danger">{error}</ErrorBanner>}
      </>
    )
    footerNote = 'Nothing happens until you press leave. You keep your Allocate account either way.'
    actions = (
      <>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
          STAY
        </Button>
        <Button variant="danger-solid" size="sm" onClick={handleLeave} disabled={!checked || submitting}>
          {submitting ? 'LEAVING…' : `LEAVE ${companyName.toUpperCase()}`}
        </Button>
      </>
    )
  }

  const header = (
    <div className={styles.header}>
      <span className={styles.meta}>{meta}</span>
      <button type="button" className={styles.cancel} onClick={onClose}>
        CANCEL ✕
      </button>
    </div>
  )

  const footer = (
    <div className={styles.footer}>
      {footerNote && <p className={styles.footerNote}>{footerNote}</p>}
      <div className={styles.footerActions}>{actions}</div>
    </div>
  )

  const bodyContent = (
    <>
      {header}
      <div className={styles.stack}>{content}</div>
    </>
  )

  if (isMobile) {
    return (
      <FullScreenSheet open onClose={onClose} footer={actions ? footer : undefined}>
        {bodyContent}
      </FullScreenSheet>
    )
  }

  return (
    <Modal open onClose={onClose} width={760} footer={actions ? footer : undefined} className={styles.modal}>
      {bodyContent}
    </Modal>
  )
}
