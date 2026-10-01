'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { signInWithEmailAndPassword, signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase'
import { operatorSignIn } from '@/actions/operator-auth'
import AuthShell from './AuthShell'
import AuthCard from './AuthCard'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import Field from '@/components/ui/Field'
import ErrorBanner from '@/components/ui/ErrorBanner'
// Shares LoginForm's stylesheet — this screen is a deliberate visual mirror
// of the customer login screen, not a fork, so it reuses the same classes
// rather than duplicating them.
import styles from './LoginForm.module.css'

// Generic copy on every failure path (bad password, unknown account, wrong
// account signed in but not an operator) — never reveal which case occurred.
// Matches the wording LoginForm.tsx uses for its own invalid-credential case.
const GENERIC_ERROR = "That email and password don't match."

export default function OperatorLoginForm() {
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
      const idToken = await credential.user.getIdToken(true)

      const result = await operatorSignIn(idToken)

      if (result.ok) {
        router.push('/operator/customers')
        return
      }

      // Authenticated with Firebase but not an operator (or the server-side
      // check otherwise failed) — undo the client-side sign-in so no stray
      // Firebase Auth session lingers for an account that got no cookie.
      await signOut(auth).catch(() => {})
      setError(GENERIC_ERROR)
    } catch (err) {
      // auth/wrong-password and auth/user-not-found are legacy SDK v8 codes;
      // SDK v9+ unifies them into auth/invalid-credential to prevent enumeration.
      const code = (err as { code?: string }).code ?? ''
      if (code === 'auth/too-many-requests') {
        setError('Too many attempts. Wait a few minutes and try again.')
      } else {
        setError(GENERIC_ERROR)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell footer="none">
      <AuthCard width={400}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>Operator sign in</h1>
          <span className={styles.subtitle}>Internal staff access only.</span>
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

            <Field label="Password" htmlFor="password">
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
      </AuthCard>
    </AuthShell>
  )
}
