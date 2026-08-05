'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { onAuthStateChanged, signOut, type User } from 'firebase/auth'
import { auth } from '@/lib/firebase'
import { createSession } from '@/actions/auth'
import { sendVerificationEmail } from '@/actions/auth-email'
import { useCountdown } from '@/hooks/useCountdown'
import AuthShell from './AuthShell'
import AuthCard from './AuthCard'
import Button from '@/components/ui/Button'
import ErrorBanner from '@/components/ui/ErrorBanner'
import styles from './VerifyEmailForm.module.css'

const POLL_INTERVAL_MS = 5_000
const POLL_TIMEOUT_MS = 10 * 60 * 1_000 // bound the background loop to ~10 minutes
const RESEND_COOLDOWN_MS = 60 * 1_000

type ViewState = 'polling' | 'cooldown' | 'failed'

export default function VerifyEmailForm() {
  const router = useRouter()

  const [currentUser, setCurrentUser] = useState<User | null | undefined>(undefined)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [resendDeadline, setResendDeadline] = useState<number | null>(null)

  const { secondsLeft, label } = useCountdown(resendDeadline)
  const cooldownActive = resendDeadline !== null && secondsLeft > 0
  const viewState: ViewState = failed ? 'failed' : cooldownActive ? 'cooldown' : 'polling'

  // onAuthStateChanged does not re-fire when emailVerified flips on an
  // existing session — it only reports the state Firebase already cached at
  // load. It still handles the case where the user arrives already verified.
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user?.emailVerified) {
        user.getIdToken(true).then((freshToken) => createSession(freshToken)).then(() => {
          router.push('/bookings')
        }).catch(() => {
          setCurrentUser(user)
        })
      } else {
        setCurrentUser(user)
      }
    })
    return unsubscribe
  }, [router])

  // Background poll — the only way to notice emailVerified flip to true
  // without the user coming back to this tab. Bounded and cleaned up on
  // unmount so a backgrounded tab doesn't burn quota indefinitely.
  useEffect(() => {
    if (!currentUser || currentUser.emailVerified) return

    let cancelled = false
    const startedAt = Date.now()

    const interval = setInterval(() => {
      if (cancelled) return
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        clearInterval(interval)
        return
      }

      currentUser
        .reload()
        .then(() => {
          if (cancelled) return
          const reloaded = auth.currentUser
          if (reloaded?.emailVerified) {
            clearInterval(interval)
            return reloaded.getIdToken(true).then((freshToken) => createSession(freshToken)).then(() => {
              if (!cancelled) router.push('/bookings')
            })
          }
          return undefined
        })
        .catch(() => {
          // Most likely the user signed out mid-poll — stop quietly.
          clearInterval(interval)
        })
    }, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [currentUser, router])

  if (currentUser === undefined) {
    return (
      <AuthShell>
        <AuthCard width={420} gap={24}>
          <h1 className={styles.title}>Verify email</h1>
        </AuthCard>
      </AuthShell>
    )
  }

  if (currentUser === null) {
    return (
      <AuthShell>
        <AuthCard width={420} gap={24}>
          <h1 className={styles.title}>Verify email</h1>
          <span className={styles.footerText}>
            <Link className={styles.link} href="/login">Sign in to continue</Link>
          </span>
        </AuthCard>
      </AuthShell>
    )
  }

  async function handleSignOut() {
    await signOut(auth).catch(() => {})
    router.push('/signup')
  }

  async function handleResend() {
    if (!currentUser) return
    setSending(true)
    try {
      const idToken = await currentUser.getIdToken()
      const result = await sendVerificationEmail(idToken)
      if (result.error) {
        setFailed(true)
      } else {
        setFailed(false)
        setResendDeadline(Date.now() + RESEND_COOLDOWN_MS)
      }
    } catch {
      setFailed(true)
    } finally {
      setSending(false)
    }
  }

  async function handleContinue() {
    if (!currentUser) return
    setChecking(true)
    setCheckError(null)
    try {
      await currentUser.reload()
      const reloaded = auth.currentUser
      if (!reloaded) {
        setCheckError('Session expired. Please sign in again.')
        return
      }
      if (!reloaded.emailVerified) {
        setCheckError("Your email hasn't been verified yet. Check your inbox.")
        return
      }
      const freshToken = await reloaded.getIdToken(true)
      await createSession(freshToken)
      router.push('/bookings')
    } catch {
      setCheckError('Something went wrong. Please try again.')
    } finally {
      setChecking(false)
    }
  }

  const resendLabel =
    viewState === 'cooldown' ? `Resend in ${label}` : viewState === 'failed' ? 'Try resend again' : 'Resend email'

  // Rendered twice — once inline for desktop (hidden on mobile), once via
  // `AuthCard`'s `stickyActions` (hidden on desktop, fixed to the bottom on
  // mobile per the mobile design file).
  const actions = (
    <>
      <Button size="lg" loading={checking} onClick={handleContinue} disabled={sending}>
        {checking ? 'Checking…' : "I've verified, continue"}
      </Button>
      <Button
        variant="secondary"
        size="lg"
        onClick={handleResend}
        disabled={sending || checking || viewState === 'cooldown'}
      >
        {sending ? 'Sending…' : resendLabel}
      </Button>
    </>
  )

  return (
    <AuthShell>
      <AuthCard width={420} gap={24} stickyActions={actions}>
        <div className={styles.titleBlock}>
          {viewState === 'failed' && <span className={styles.eyebrow}>NOT VERIFIED</span>}
          <h1 className={styles.title}>Check your email</h1>
          {viewState !== 'failed' && (
            <span className={styles.body}>
              We sent a confirmation link to <strong>{currentUser.email}</strong>. Open it to
              finish setting up your account — this page continues on its own once you do.
            </span>
          )}
        </div>

        {viewState === 'failed' && (
          <div className={styles.failedBlock}>
            <ErrorBanner tone="danger">
              We couldn&apos;t send the email just now. Wait a minute and try again.
            </ErrorBanner>
            <span className={styles.body}>
              Your previous verification link is still valid — check your inbox and spam folder.
            </span>
          </div>
        )}

        {checkError && <ErrorBanner tone="danger">{checkError}</ErrorBanner>}

        <div className={`${styles.actions} ${styles.desktopActions}`}>{actions}</div>

        {viewState !== 'failed' && (
          <span className={styles.checking}>
            <span className={styles.checkingDot} aria-hidden="true" />
            Checking for verification…
          </span>
        )}

        <span className={styles.footerText}>
          Wrong address?{' '}
          <button type="button" className={styles.link} onClick={handleSignOut}>
            Sign out
          </button>{' '}
          and create the account again.
        </span>
      </AuthCard>
    </AuthShell>
  )
}
