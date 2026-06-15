'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  applyActionCode,
  verifyPasswordResetCode,
  confirmPasswordReset,
  signOut,
} from 'firebase/auth'
import { auth } from '@/lib/firebase'
import { createSession } from '@/actions/auth'
import styles from './Auth.module.css'

type State =
  | { status: 'loading' }
  | { status: 'success' }
  | { status: 'error'; message: string; backTo: string; backLabel: string }
  | { status: 'reset_form'; email: string }
  | { status: 'reset_submitting' }
  | { status: 'reset_done' }
  | { status: 'email_changed' }

function errorMessage(err: unknown): string {
  const code = (err as { code?: string }).code ?? ''
  if (code === 'auth/invalid-action-code' || code === 'auth/expired-action-code') {
    return 'The link has expired or already been used. Request a new one.'
  }
  return 'Something went wrong. Please try again.'
}

export default function AuthActionHandler({
  mode,
  oobCode,
}: {
  mode?: string
  oobCode?: string
}) {
  const router = useRouter()
  const [state, setState] = useState<State>({ status: 'loading' })
  const [password, setPassword] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)

  useEffect(() => {
    if (!oobCode) {
      setState({ status: 'error', message: 'Invalid link.', backTo: '/login', backLabel: 'Back to sign in' })
      return
    }

    if (mode === 'verifyEmail') {
      applyActionCode(auth, oobCode)
        .then(async () => {
          const user = auth.currentUser
          if (user) {
            const freshToken = await user.getIdToken(true)
            await createSession(freshToken)
            router.push('/bookings')
          } else {
            router.push('/login')
          }
        })
        .catch((err) => {
          setState({
            status: 'error',
            message: errorMessage(err),
            backTo: '/verify-email',
            backLabel: 'Back to verification',
          })
        })
      return
    }

    if (mode === 'verifyAndChangeEmail') {
      applyActionCode(auth, oobCode)
        .then(async () => {
          // The sign-in email changed, so the client identity and any existing
          // session are now stale — sign out and send the user back to sign in
          // with the new address.
          await signOut(auth).catch(() => {})
          setState({ status: 'email_changed' })
          router.push('/login?emailChanged=1')
        })
        .catch((err) => {
          setState({
            status: 'error',
            message: errorMessage(err),
            backTo: '/login',
            backLabel: 'Back to sign in',
          })
        })
      return
    }

    if (mode === 'resetPassword') {
      verifyPasswordResetCode(auth, oobCode)
        .then((email) => {
          setState({ status: 'reset_form', email })
        })
        .catch((err) => {
          setState({
            status: 'error',
            message: errorMessage(err),
            backTo: '/login',
            backLabel: 'Back to sign in',
          })
        })
      return
    }

    setState({
      status: 'error',
      message: 'Invalid link.',
      backTo: '/login',
      backLabel: 'Back to sign in',
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!oobCode) return
    if (password.length < 8) {
      setPasswordError('Password must be at least 8 characters.')
      return
    }
    setPasswordError(null)
    setState({ status: 'reset_submitting' })
    try {
      await confirmPasswordReset(auth, oobCode, password)
      setState({ status: 'reset_done' })
      router.push('/login?passwordReset=1')
    } catch (err) {
      setState({
        status: 'error',
        message: errorMessage(err),
        backTo: '/login',
        backLabel: 'Back to sign in',
      })
    }
  }

  if (state.status === 'loading' || state.status === 'success') {
    return (
      <div className={styles.page}>
        <div className={styles.formCard}>
          <h1 className={styles.pageTitle}>
            {mode === 'resetPassword' ? 'Reset Password' : 'Verifying'}
          </h1>
        </div>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className={styles.page}>
        <div className={styles.formCard}>
          <h1 className={styles.pageTitle}>Something went wrong</h1>
          <div className={styles.error} role="alert">
            {state.message}
          </div>
          <p className={styles.footer}>
            <Link href={state.backTo}>{state.backLabel}</Link>
          </p>
        </div>
      </div>
    )
  }

  if (state.status === 'reset_form' || state.status === 'reset_submitting') {
    const submitting = state.status === 'reset_submitting'
    const email = state.status === 'reset_form' ? state.email : ''
    return (
      <div className={styles.page}>
        <div className={styles.formCard}>
          <h1 className={styles.pageTitle}>Reset Password</h1>
          {email && (
            <p style={{ color: 'var(--on-surface-variant)', fontSize: 'var(--font-body)' }}>
              {email}
            </p>
          )}
          <form className={styles.form} onSubmit={handlePasswordSubmit}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="new-password">
                New password
              </label>
              <input
                id="new-password"
                type="password"
                className={styles.input}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Min. 8 characters"
                disabled={submitting}
                autoComplete="new-password"
                autoFocus
              />
            </div>
            {passwordError && (
              <div className={styles.error} role="alert">
                {passwordError}
              </div>
            )}
            <button type="submit" className={styles.submitBtn} disabled={submitting}>
              {submitting ? 'Saving…' : 'Set new password'}
            </button>
          </form>
          <p className={styles.footer}>
            <Link href="/login">Back to sign in</Link>
          </p>
        </div>
      </div>
    )
  }

  if (state.status === 'reset_done') {
    return (
      <div className={styles.page}>
        <div className={styles.formCard}>
          <h1 className={styles.pageTitle}>Password updated</h1>
        </div>
      </div>
    )
  }

  if (state.status === 'email_changed') {
    return (
      <div className={styles.page}>
        <div className={styles.formCard}>
          <h1 className={styles.pageTitle}>Email updated</h1>
        </div>
      </div>
    )
  }

  return null
}
