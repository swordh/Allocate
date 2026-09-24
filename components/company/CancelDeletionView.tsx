'use client'

import { useState } from 'react'
import Button from '@/components/ui/Button'
import ErrorBanner from '@/components/ui/ErrorBanner'
import { cancelCompanyDeletionByToken } from '@/actions/companyDeletion'
import type { CancelTokenState } from '@/lib/queries/companyDeletionCancel'
import styles from './CancelDeletionView.module.css'

interface CancelDeletionViewProps {
  token: string
  initialState: CancelTokenState
  companyName: string
  /** ISO string, or '' when unknown. Only meaningful while a deletion is still pending. */
  scheduledFor: string
  requestedByName: string
}

interface Copy {
  eyebrow: string
  heading: string
  body: string
  tone: 'accent' | 'danger' | 'neutral'
}

function formatDate(iso: string): string {
  if (!iso) return 'the scheduled date'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'the scheduled date'
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

/**
 * One message per outcome, never a shared "something went wrong."
 *
 * The person reading this screen got here from an email about a company being
 * deleted; three of these outcomes mean the company is safe, two mean the link
 * is spent but say nothing about the company, and one means the company is
 * already gone. Collapsing them would leave an admin unable to tell "you are
 * too late" from "you were never needed", which is the exact confusion the
 * design brief calls out for the two error states it names ("Kunde inte
 * avgöras" vs "Blockerad").
 */
function copyFor(state: CancelTokenState, companyName: string, scheduledFor: string, requestedByName: string): Copy {
  const named = companyName || 'this company'
  switch (state) {
    case 'valid':
      return {
        eyebrow: 'DELETION SCHEDULED',
        heading: `Stop the deletion of ${named}?`,
        body: `${requestedByName || 'An administrator'} asked for ${named} to be deleted on ${formatDate(scheduledFor)}. Stopping it keeps the company, its bookings and its equipment exactly as they are, and resumes billing on the same plan. Nobody loses anything.`,
        tone: 'danger',
      }
    case 'already_canceled':
      return {
        eyebrow: 'NOTHING TO DO',
        heading: `${named} is not being deleted`,
        body: 'This deletion has already been stopped — by another administrator, or by this same link. Nothing was deleted and nothing will be.',
        tone: 'accent',
      }
    case 'used':
      return {
        eyebrow: 'LINK ALREADY USED',
        heading: 'This link has already been used',
        body: 'Cancellation links work once. If the deletion was stopped, it stays stopped — you can sign in to check the current state. If a new deletion has been requested since, use the link from that newer email.',
        tone: 'neutral',
      }
    case 'expired':
      return {
        eyebrow: 'LINK EXPIRED',
        heading: 'This link has expired',
        body: 'A cancellation link lives exactly as long as the seven-day window it belongs to. Sign in to check where things stand, or contact support.',
        tone: 'neutral',
      }
    case 'too_late':
      return {
        eyebrow: 'ALREADY UNDER WAY',
        heading: 'This deletion has already started',
        body: `The deletion of ${named} has already started and can no longer be stopped from this link. Contact support straight away if this is wrong.`,
        tone: 'danger',
      }
    case 'company_gone':
      return {
        eyebrow: 'ALREADY DELETED',
        heading: `${named} has been deleted`,
        body: 'The deletion has already been carried out. It cannot be undone, and there is nothing left for this link to stop.',
        tone: 'danger',
      }
    case 'unknown':
    default:
      return {
        eyebrow: 'LINK NOT RECOGNISED',
        heading: "We don't recognise this link",
        body: 'Check that you copied the whole address from the email. If it still does not work, sign in to Allocate to see whether a deletion is scheduled, or contact support.',
        tone: 'neutral',
      }
  }
}

/**
 * The cancel screen behind a mailed link (issue #252 step 5, PR F2).
 *
 * The button is the entire point of this component. Loading the page must
 * not cancel anything — see the docblock on `cancelCompanyDeletionByToken`
 * and on `lookupCancelToken`: mail scanners and link prefetchers fetch these
 * URLs unprompted, and a deletion stopped by a robot is as wrong as one
 * executed by a robot. The page reads; only a submitted form writes.
 */
export default function CancelDeletionView({
  token,
  initialState,
  companyName,
  scheduledFor,
  requestedByName,
}: CancelDeletionViewProps) {
  const [state, setState] = useState<CancelTokenState>(initialState)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const copy = copyFor(state, companyName, scheduledFor, requestedByName)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await cancelCompanyDeletionByToken(token)
      // A successful cancellation comes back as `valid` — the state the
      // token was IN when it was spent. Map it to the message the visitor
      // should now see, which is the same one a second visit would get.
      setState(result.state === 'valid' ? 'already_canceled' : result.state)
    } catch {
      setError('Could not stop the deletion right now. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.wrapper}>
      <span className={styles.logo}>ALLOCATE</span>

      <div className={styles.card} data-tone={copy.tone}>
        <span className={styles.eyebrow}>{copy.eyebrow}</span>
        <h1 className={styles.heading}>{copy.heading}</h1>
        <p className={styles.body}>{copy.body}</p>

        {error && <ErrorBanner tone="danger">{error}</ErrorBanner>}

        {state === 'valid' && (
          <form onSubmit={handleSubmit} className={styles.form}>
            <Button type="submit" size="lg" fullWidth loading={busy}>
              {busy ? 'Stopping…' : 'Stop the deletion'}
            </Button>
            <p className={styles.fineprint}>
              Nothing happens until you press the button. This link can only stop a deletion — it can
              never start one.
            </p>
          </form>
        )}
      </div>
    </div>
  )
}
