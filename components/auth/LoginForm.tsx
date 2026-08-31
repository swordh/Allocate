'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { signInWithEmailAndPassword } from 'firebase/auth'
import { auth } from '@/lib/firebase'
import { createSession } from '@/actions/auth'
import { sendVerificationEmail } from '@/actions/auth-email'
import AuthShell from './AuthShell'
import AuthCard from './AuthCard'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import Field from '@/components/ui/Field'
import ErrorBanner from '@/components/ui/ErrorBanner'
import styles from './LoginForm.module.css'

// The design's `locked` state (15-minute lockout, "Two attempts left…" copy)
// is intentionally not built — redesign decision 3. Firebase's existing
// auth/too-many-requests behaviour is kept as-is with neutral copy instead.

export default function LoginForm() {
  const router = useRouter()

  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState<string | null>(null)
  const [loading,  setLoading]  = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const credential = await signInWithEmailAndPassword(auth, email.trim(), password)
      await credential.user.reload()
      const idToken = await credential.user.getIdToken(true)
      if (!credential.user.emailVerified) {
        sendVerificationEmail(idToken).catch(() => {})
        await createSession(idToken)
        router.push('/verify-email')
      } else {
        await createSession(idToken)
        router.push('/bookings')
      }
    } catch (err) {
      // auth/wrong-password and auth/user-not-found are legacy SDK v8 codes;
      // SDK v9+ unifies them into auth/invalid-credential to prevent enumeration.
      const code = (err as { code?: string }).code ?? ''
      if (code === 'auth/invalid-credential') {
        setError("That email and password don't match.")
      } else if (code === 'auth/too-many-requests') {
        setError('Too many attempts. Wait a few minutes and try again.')
      } else {
        setError('Something went wrong. Please try again.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell>
      <AuthCard width={400}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>Sign in</h1>
          <span className={styles.subtitle}>Use the email address your workspace invited.</span>
        </div>

        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          {error && <ErrorBanner tone="danger">{error}</ErrorBanner>}

          <div className={styles.fieldsGroup}>
            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                inputSize="lg"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={loading}
                busy={loading}
              />
            </Field>

            <Field
              label="Password"
              htmlFor="password"
              labelAction={
                <Link className={styles.forgotLink} href="/forgot-password">
                  FORGOT?
                </Link>
              }
            >
              <Input
                id="password"
                inputSize="lg"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={loading}
                invalid={!!error}
                busy={loading}
              />
            </Field>
          </div>

          <Button type="submit" size="lg" fullWidth loading={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <span className={styles.footerText}>
          No account yet?{' '}
          <Link className={styles.link} href="/signup">
            Create an account
          </Link>
        </span>
      </AuthCard>
    </AuthShell>
  )
}
