'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase'
import { setupNewCompany, createSession, deleteSession } from '@/actions/auth'
import { exportUserData } from '@/actions/account'
import { daysLeftLabel } from '@/lib/pendingDeletionCountdown'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import Field from '@/components/ui/Field'
import ErrorBanner from '@/components/ui/ErrorBanner'
import styles from './NoCompanyView.module.css'

interface PendingDeletionProps {
  scheduledFor: string // ISO string
}

interface NoCompanyViewProps {
  name: string
  email: string
  /** Set only for a stranded former member — see types/user.ts's `PendingAccountDeletion`. */
  pendingDeletion: PendingDeletionProps | null
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
 * Both get exactly the two paths the brief names: export her data, or
 * create a new company (which cancels the schedule — see the
 * `pendingDeletion: FieldValue.delete()` write inside `setupNewCompany`,
 * actions/auth.ts).
 */
export default function NoCompanyView({ name, email, pendingDeletion }: NoCompanyViewProps) {
  const router = useRouter()

  const [companyName, setCompanyName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const [signingOut, setSigningOut] = useState(false)

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
        <span className={styles.eyebrow}>{pendingDeletion ? 'COMPANY DELETED' : 'NO COMPANY'}</span>
        <h1 className={styles.heading}>
          {pendingDeletion ? "You're not part of a company anymore" : 'Create your company'}
        </h1>
        <p className={styles.subheading}>
          {pendingDeletion ? (
            <>
              The company you belonged to was deleted, and you were its only member left. You can still
              sign in, export your data, or create a new company — doing so cancels the countdown below.
              If you do neither, your account is deleted in{' '}
              <strong>{daysLeftLabel(pendingDeletion.scheduledFor)}</strong>.
            </>
          ) : (
            <>You&apos;re signed in as {email}, but not part of a company yet. Create one to continue.</>
          )}
        </p>
        {pendingDeletion && (
          <div className={styles.countdown} role="status">
            <span className={styles.countdownValue}>{daysLeftLabel(pendingDeletion.scheduledFor)}</span>
            <span className={styles.countdownLabel}>until your account is deleted</span>
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
      </div>

      <button type="button" className={styles.signOutLink} onClick={handleSignOut} disabled={signingOut}>
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  )
}
