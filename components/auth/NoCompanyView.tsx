'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase'
import { setupNewCompany, createSession, deleteSession } from '@/actions/auth'
import { exportUserData, deleteAccount } from '@/actions/account'
import { pendingDeletionCountdown } from '@/lib/pendingDeletionCountdown'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import Field from '@/components/ui/Field'
import ErrorBanner from '@/components/ui/ErrorBanner'
import styles from './NoCompanyView.module.css'

interface NoCompanyViewProps {
  name: string
  email: string
  /**
   * True only for a stranded former member — see types/user.ts's
   * `PendingAccountDeletion`.
   */
  deletionScheduled: boolean
  /**
   * The deadline, ISO, or null when it is missing or unreadable. Deliberately
   * the DATE and nothing else: the rest of `pendingDeletion` — in particular
   * `requestId`, the `companyDeletions` document id — must not cross the RSC
   * boundary into the page payload. See the prop comment in
   * app/(auth)/no-company/page.tsx.
   */
  deletionScheduledFor: string | null
}

/**
 * Landing screen for a signed-in user with no active company (issue #252
 * step 5, PR F — design brief "Del 3: Den som blir kvar utan företag").
 *
 * Two callers land here with different, but overlapping, needs:
 *   - A stranded former member: her only company was deleted by an admin's
 *     decision, and the purge (functions/src/company/memberCleanup.ts)
 *     scheduled her account for deletion thirty days out. `pendingDeletion`
 *     is set — she sees the countdown the brief requires ("Nedräkningen ska
 *     gå att se, inte bara stå i ett mail hon kanske missade").
 *   - Any other signed-in user who reaches an app route with no
 *     `activeCompanyId` claim at all (e.g. a session created mid-signup
 *     before `setupNewCompany` ran). `pendingDeletion` is null — same page,
 *     same two ways forward, no countdown to show.
 *
 * Both get the two paths the brief names — export her data, or create a new
 * company (which cancels the schedule — see the `pendingDeletion:
 * FieldValue.delete()` write inside `setupNewCompany`, actions/auth.ts) —
 * plus a third: delete the account outright (GDPR Art. 17, issue #362). A
 * companyless user previously had no way to exercise her right to erasure at
 * all: `deleteAccount` (actions/account.ts) used to require an
 * `activeCompanyId`, and this very page is where a companyless session is
 * redirected. It now uses `verifyAuthenticatedSession` instead, the same
 * fix already made for `exportUserData` — see that function's docblock.
 */
export default function NoCompanyView({
  name,
  email,
  deletionScheduled,
  deletionScheduledFor,
}: NoCompanyViewProps) {
  const router = useRouter()

  // Computed on the client, from `Date.now()` at render time. `kind` is
  // 'unknown' whenever the date is missing or unparseable, which is why the
  // countdown block below is gated on the kind and not on
  // `deletionScheduled`: she is told she is scheduled either way, but a
  // number is only shown when there is a real one to show.
  const countdown = pendingDeletionCountdown(deletionScheduledFor)

  const [companyName, setCompanyName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const [signingOut, setSigningOut] = useState(false)

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [confirmInput, setConfirmInput] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // issue #349: `setDeleting(true)` isn't synchronous, so a fast double click
  // can fire handleDeleteAccount twice before `disabled` re-renders. This ref
  // is set synchronously, before any `await`, closing that window on the
  // client — same pattern as AccountSettingsForm.tsx. The server-side lock
  // (actions/account.ts) is the real guard.
  const deletingRef = useRef(false)

  async function handleCreateCompany(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = companyName.trim()
    if (!trimmed) return

    setCreating(true)
    setCreateError(null)

    try {
      const user = auth.currentUser
      if (!user) {
        setCreateError('Your session expired. Please sign in again.')
        return
      }
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const idToken = await user.getIdToken()
      await setupNewCompany(idToken, trimmed, name || (user.displayName ?? ''), timezone)

      // Force token refresh to pick up the new activeCompanyId claim, then
      // re-issue the session cookie from it — same pattern SignupForm and
      // VerifyEmailForm already use.
      const freshToken = await user.getIdToken(/* forceRefresh */ true)
      await createSession(freshToken)
      router.push('/bookings')
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      setCreateError(msg === 'already-exists' ? 'You already have an active company.' : 'Could not create your company. Please try again.')
    } finally {
      setCreating(false)
    }
  }

  async function handleExportData() {
    setExporting(true)
    setExportError(null)
    const result = await exportUserData()
    setExporting(false)
    if (result.error) {
      setExportError(result.error)
      return
    }
    const blob = new Blob([result.json!], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'allocate-my-data.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleDeleteAccount() {
    if (confirmInput !== 'DELETE' || deletingRef.current) return
    deletingRef.current = true
    setDeleting(true)
    setDeleteError(null)

    const result = await deleteAccount()

    if (result.error) {
      setDeleteError(result.error)
      setDeleting(false)
      deletingRef.current = false
    } else {
      // Best-effort, same as handleSignOut below — deleteAccount already
      // cleared the server-side session and Auth record, but the client
      // SDK's own in-memory state survives until signOut() clears it. Never
      // let a failure here block the redirect.
      await signOut(auth).catch(() => {})
      router.push('/login')
    }
  }

  async function handleSignOut() {
    setSigningOut(true)
    await signOut(auth).catch(() => {})
    await deleteSession().catch(() => {})
    router.push('/login')
  }

  return (
    <div className={styles.wrapper}>
      <span className={styles.logo}>ALLOCATE</span>

      <div className={styles.intro}>
        <span className={styles.eyebrow}>{deletionScheduled ? 'COMPANY DELETED' : 'NO COMPANY'}</span>
        <h1 className={styles.heading}>
          {deletionScheduled ? "You're not part of a company anymore" : 'Create your company'}
        </h1>
        <p className={styles.subheading}>
          {deletionScheduled ? (
            <>
              The company you belonged to was deleted, and you were its only member left. You can still
              sign in, export your data, or create a new company — doing so cancels the deletion of your
              account.{' '}
              {countdown.kind === 'counting' && (
                <>
                  If you do neither, your account is deleted in{' '}
                  <strong>{countdown.label}</strong>.
                </>
              )}
              {/*
                * Past the deadline the sentence above would be a lie, and
                * "Less than a day left" — what this rendered before — is a
                * lie that repeats forever. `strandedAccountSweep`
                * (functions/src/company/strandedAccountSweep.ts, issue #252
                * step 6) now enforces the deadline, running at most every 24
                * hours — so this state is reachable for up to a day after
                * the deadline passes, on every stranded user, not a rare
                * edge case. The copy below ("can be removed as soon as it
                * is processed") is written to stay true either way.
                */}
              {countdown.kind === 'passed' && (
                <>
                  Your account is <strong>past its scheduled deletion date</strong> and can be removed as
                  soon as it is processed. Create a company now if you want to keep it.
                </>
              )}
              {countdown.kind === 'unknown' && (
                <>Your account is scheduled for deletion.</>
              )}
            </>
          ) : (
            <>You&apos;re signed in as {email}, but not part of a company yet. Create one to continue.</>
          )}
        </p>
        {countdown.kind !== 'unknown' && deletionScheduled && (
          <div className={styles.countdown} role="status">
            <span className={styles.countdownValue}>{countdown.label}</span>
            <span className={styles.countdownLabel}>{countdown.caption}</span>
          </div>
        )}
      </div>

      <div className={styles.cardGrid}>
        <form className={styles.card} onSubmit={handleCreateCompany}>
          <h2 className={styles.cardTitle}>Create a new company</h2>
          <p className={styles.cardBody}>Start fresh with a new workspace. This is your place again.</p>
          <Field label="Company name" htmlFor="companyName">
            <Input
              id="companyName"
              inputSize="lg"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              required
              disabled={creating}
              busy={creating}
            />
          </Field>
          {createError && <ErrorBanner tone="danger">{createError}</ErrorBanner>}
          <Button type="submit" size="lg" fullWidth loading={creating} disabled={!companyName.trim()}>
            {creating ? 'Creating…' : 'Create company'}
          </Button>
        </form>

        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Export your data</h2>
          <p className={styles.cardBody}>Download a copy of your profile and booking history as JSON.</p>
          {exportError && <ErrorBanner tone="danger">{exportError}</ErrorBanner>}
          <Button variant="secondary" size="lg" fullWidth loading={exporting} onClick={handleExportData}>
            {exporting ? 'Preparing…' : 'Export my data'}
          </Button>
        </div>

        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Delete your account</h2>
          <p className={styles.cardBody}>
            Permanently erases your profile and booking history. This happens immediately and cannot be
            undone — export your data first if you want to keep a copy.
          </p>
          {!deleteOpen && (
            <Button variant="danger" size="lg" fullWidth onClick={() => setDeleteOpen(true)}>
              Delete my account
            </Button>
          )}
          {deleteOpen && (
            <div className={styles.deleteConfirm}>
              <span className={styles.deleteText} id="noCompanyDeleteConfirmHelp">
                Type DELETE to permanently remove your account.
              </span>
              <div className={styles.deleteInputRow}>
                <Input
                  value={confirmInput}
                  onChange={(e) => {
                    setConfirmInput(e.target.value)
                    setDeleteError(null)
                  }}
                  placeholder="DELETE"
                  className={styles.deleteInput}
                  disabled={deleting}
                  aria-label="Type DELETE to confirm account deletion"
                  aria-describedby="noCompanyDeleteConfirmHelp"
                />
                <Button
                  variant="danger-solid"
                  size="sm"
                  onClick={handleDeleteAccount}
                  disabled={confirmInput !== 'DELETE' || deleting}
                >
                  {deleting ? 'Deleting…' : 'Confirm'}
                </Button>
              </div>
              {deleteError && <ErrorBanner tone="danger">{deleteError}</ErrorBanner>}
            </div>
          )}
        </div>
      </div>

      <button type="button" className={styles.signOutLink} onClick={handleSignOut} disabled={signingOut}>
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  )
}
