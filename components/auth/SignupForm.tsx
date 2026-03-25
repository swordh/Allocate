'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createUserWithEmailAndPassword } from 'firebase/auth'
import { auth } from '@/lib/firebase'
import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'firebase/functions'
import { createSession } from '@/actions/auth'
import styles from './Auth.module.css'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_PASSWORD_LENGTH = 8

// ---------------------------------------------------------------------------
// Firebase Functions singleton — connectFunctionsEmulator must only be called
// once per instance; calling it on every submit causes SDK warnings.
// ---------------------------------------------------------------------------

let _functions: ReturnType<typeof getFunctions> | null = null

function getFunctionsInstance() {
  if (_functions) return _functions
  _functions = getFunctions(auth.app, 'us-central1')
  if (process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_FUNCTIONS_EMULATOR === 'true') {
    connectFunctionsEmulator(_functions, 'localhost', 5001)
  }
  return _functions
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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

    // Client-side pre-validation — trim here so spaces-only inputs are caught
    // before we hit the network.
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

    // ── Step 2: Create company — if this fails, delete the orphaned auth user
    // so the user can retry from scratch without hitting "email already in use".
    try {
      const functions = getFunctionsInstance()
      const createCompanyFn = httpsCallable<
        { companyName: string; userName: string },
        { success: boolean; companyId: string }
      >(functions, 'createCompany')

      await createCompanyFn({ companyName: trimmedCompany, userName: trimmedName })
    } catch (err) {
      // Clean up the auth user so the user can retry.
      await credential.user.delete().catch(() => {/* best-effort */})

      const code = (err as { code?: string }).code ?? ''
      if (code === 'functions/already-exists') {
        setError('This account is already set up. Please sign in.')
      } else if (code === 'functions/invalid-argument') {
        setError('Invalid company or user name.')
      } else {
        setError('Failed to set up your account. Please try again.')
      }
      setLoading(false)
      return
    }

    // ── Step 3: Force token refresh to include new custom claims, then create session
    try {
      const idToken = await credential.user.getIdToken(/* forceRefresh */ true)
      await createSession(idToken)
    } catch {
      // Clean up the auth user — session could not be established.
      await credential.user.delete().catch(() => {/* best-effort */})
      setError('Failed to create session. Please try signing in.')
      setLoading(false)
      return
    }

    router.push('/bookings')
  }

  return (
    <div className={styles.page}>
      <div className={styles.wordmark}>Allocate</div>

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

      {/* GDPR Art. 13 — inform users of data processing at point of collection */}
      <p className={styles.legal}>
        By creating an account you agree to our{' '}
        <Link href="/terms">Terms of Service</Link> and acknowledge our{' '}
        <Link href="/privacy">Privacy Policy</Link>.
      </p>
    </div>
  )
}
