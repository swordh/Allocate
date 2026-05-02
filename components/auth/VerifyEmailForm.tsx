'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { onAuthStateChanged, sendEmailVerification, type User } from 'firebase/auth'
import { auth } from '@/lib/firebase'
import { createSession } from '@/actions/auth'
import styles from './Auth.module.css'

export default function VerifyEmailForm() {
  const router = useRouter()

  const [currentUser, setCurrentUser] = useState<User | null | undefined>(undefined)
  const [resendStatus, setResendStatus] = useState<string | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      // Auto-redirect if already verified (e.g. user returns to this tab after clicking the link)
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

  if (currentUser === undefined) {
    return (
      <div className={styles.page}>
        <div className={styles.formCard}>
          <h1 className={styles.pageTitle}>VERIFY EMAIL</h1>
        </div>
      </div>
    )
  }

  if (currentUser === null) {
    return (
      <div className={styles.page}>
        <div className={styles.formCard}>
          <h1 className={styles.pageTitle}>VERIFY EMAIL</h1>
          <p className={styles.footer}>
            <Link href="/login">Sign in to continue</Link>
          </p>
        </div>
      </div>
    )
  }

  async function handleResend() {
    if (!currentUser) return
    setSending(true)
    setResendStatus(null)
    try {
      await sendEmailVerification(currentUser)
      setResendStatus('Verification email sent')
    } catch (err) {
      const code = (err as { code?: string }).code ?? ''
      if (code === 'auth/too-many-requests') {
        setResendStatus('Too many attempts. Wait a moment and try again.')
      } else {
        setResendStatus('Something went wrong. Please try again.')
      }
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

  return (
    <div className={styles.page}>
      <div className={styles.formCard}>
        <h1 className={styles.pageTitle}>VERIFY EMAIL</h1>

        <p>
          We sent a verification link to <strong>{currentUser.email}</strong>.
          Check your inbox and click the link to continue.
        </p>

        {resendStatus && (
          <div className={styles.status} role="status" aria-live="polite">
            {resendStatus}
          </div>
        )}

        {checkError && (
          <div className={styles.error} role="alert" aria-live="assertive">
            {checkError}
          </div>
        )}

        <button
          className={styles.submitBtn}
          onClick={handleContinue}
          disabled={checking || sending}
        >
          {checking ? 'Checking…' : "I've verified, continue"}
        </button>

        <button
          className={styles.submitBtn}
          onClick={handleResend}
          disabled={sending || checking}
        >
          {sending ? 'Sending…' : 'Resend email'}
        </button>
      </div>
    </div>
  )
}
