'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createUserWithEmailAndPassword } from 'firebase/auth'
import { auth } from '@/lib/firebase'
import { setupNewCompany, createSession } from '@/actions/auth'
import styles from './Auth.module.css'

const MIN_PASSWORD_LENGTH = 8

export default function SignupForm() {
  const router = useRouter()

  const [companyName, setCompanyName] = useState('')
  const [userName,    setUserName]    = useState('')
  const [email,       setEmail]       = useState('')
  const [password,    setPassword]    = useState('')
  const [error,       setError]       = useState<string | null>(null)
  const [loading,     setLoading]     = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    const trimmedCompany = companyName.trim()
    const trimmedName    = userName.trim()
    const trimmedEmail   = email.trim()

    if (!trimmedCompany) { setError('Company name is required.'); return }
    if (!trimmedName)    { setError('Your name is required.'); return }
    if (!trimmedEmail)   { setError('Email is required.'); return }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }

    setLoading(true)

    // ── Step 1: Create Firebase Auth user ──────────────────────────────────
    let credential: Awaited<ReturnType<typeof createUserWithEmailAndPassword>>
    try {
      credential = await createUserWithEmailAndPassword(auth, trimmedEmail, password)
    } catch (err) {
      const code = (err as { code?: string }).code ?? ''
      if (code === 'auth/email-already-in-use') {
        setError('An account with this email already exists.')
      } else if (code === 'auth/invalid-email') {
        setError('Invalid email address.')
      } else if (code === 'auth/weak-password') {
        setError('Password is too weak.')
      } else {
        setError('Something went wrong. Please try again.')
      }
      setLoading(false)
      return
    }

    // ── Step 2: Create company server-side (no CORS) ──────────────────────
    // Pass the initial token only for identity verification. Claims are set
    // inside setupNewCompany; we must refresh the token AFTER this call.
    try {
      const idToken = await credential.user.getIdToken()
      await setupNewCompany(idToken, trimmedCompany, trimmedName)
    } catch (err) {
      // Clean up the orphaned auth user so the user can retry.
      await credential.user.delete().catch(() => {/* best-effort */})

      const msg = err instanceof Error ? err.message : ''
      if (msg === 'already-exists') {
        setError('This account is already set up. Please sign in.')
      } else {
        setError('Failed to set up your account. Please try again.')
      }
      setLoading(false)
      return
    }

    // ── Step 3: Force token refresh to pick up new claims, then create session
    try {
      const freshToken = await credential.user.getIdToken(/* forceRefresh */ true)
      await createSession(freshToken)
    } catch {
      await credential.user.delete().catch(() => {/* best-effort */})
      setError('Failed to create session. Please try signing in.')
      setLoading(false)
      return
    }

    router.push('/bookings')
  }

  return (
    <div className={styles.page}>
      <div className={styles.formCard}>
        <h1 className={styles.pageTitle}>CREATE ACCOUNT</h1>

        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          {error && (
            <div className={styles.error} role="alert" aria-live="assertive">
              {error}
            </div>
          )}

          <div className={styles.field}>
            <label className={styles.label} htmlFor="companyName">Company name</label>
            <input
              id="companyName"
              className={styles.input}
              type="text"
              autoComplete="organization"
              maxLength={100}
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              required
              disabled={loading}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="userName">Your name</label>
            <input
              id="userName"
              className={styles.input}
              type="text"
              autoComplete="name"
              maxLength={100}
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              required
              disabled={loading}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="email">Email</label>
            <input
              id="email"
              className={styles.input}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={loading}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="password">
              Password <span className={styles.labelHint}>(min {MIN_PASSWORD_LENGTH} characters)</span>
            </label>
            <input
              id="password"
              className={styles.input}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={loading}
            />
          </div>

          <button className={styles.submitBtn} type="submit" disabled={loading}>
            {loading ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p className={styles.footer}>
          Already have an account?{' '}
          <Link href="/login">Sign in</Link>
        </p>

        <p className={styles.legal}>
          By creating an account you agree to our{' '}
          <Link href="/terms">Terms of Service</Link> and acknowledge our{' '}
          <Link href="/privacy">Privacy Policy</Link>.
        </p>
      </div>
    </div>
  )
}
