'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { createUserWithEmailAndPassword, sendEmailVerification, updateProfile } from 'firebase/auth'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '@/lib/firebase'
import { setupNewCompany, createSession } from '@/actions/auth'
import styles from './Auth.module.css'

const MIN_PASSWORD_LENGTH = 8

// Extract invite token from a redirect path like /invite/<token>
function extractInviteToken(redirect: string | null): string | null {
  if (!redirect) return null
  const match = redirect.match(/^\/invite\/([a-zA-Z0-9]{1,40})$/)
  return match ? match[1] : null
}

export default function SignupForm() {
  const router       = useRouter()
  const searchParams = useSearchParams()

  const redirectParam = searchParams.get('redirect')
  const emailParam    = searchParams.get('email') ?? ''
  const inviteToken   = extractInviteToken(redirectParam)

  // Mode state machine — 'choose' by default unless arriving via invite link
  const [mode, setMode] = useState<'choose' | 'create' | 'invite'>(
    inviteToken ? 'invite' : 'choose'
  )
  const [inviteInput,      setInviteInput]      = useState('')
  const [inviteValidating, setInviteValidating] = useState<'idle' | 'checking' | 'valid' | 'error'>('idle')
  const [inviteError,      setInviteError]      = useState<string | null>(null)
  const [resolvedToken,    setResolvedToken]    = useState<string | null>(inviteToken)
  const [emailLocked,      setEmailLocked]      = useState(inviteToken !== null)

  const [companyName, setCompanyName] = useState('')
  const [userName,    setUserName]    = useState('')
  const [email,       setEmail]       = useState(emailParam)
  const [password,    setPassword]    = useState('')
  const [error,       setError]       = useState<string | null>(null)
  const [loading,     setLoading]     = useState(false)

  async function handleInviteValidation() {
    setInviteError(null)

    const trimmed = inviteInput.trim()
    if (!trimmed) {
      setInviteError('Ange en inbjudningslänk eller kod.')
      return
    }

    // Try to extract token from a URL, otherwise treat the whole string as token
    let token = trimmed
    try {
      const url = new URL(trimmed)
      const pathMatch = url.pathname.match(/^\/invite\/([a-zA-Z0-9]{1,40})$/)
      if (pathMatch) {
        token = pathMatch[1]
      }
    } catch {
      // Not a URL — use raw input as token
    }

    // Validate format
    if (!/^[a-zA-Z0-9]{1,40}$/.test(token)) {
      setInviteError('Ogiltig format på inbjudningskod.')
      return
    }

    setInviteValidating('checking')

    try {
      const snap = await getDoc(doc(db, 'invitations', token))
      if (!snap.exists() || snap.data()?.status !== 'pending') {
        setInviteValidating('error')
        setInviteError('Länken är ogiltig, redan använd eller har löpt ut.')
        return
      }

      const inviteEmail = snap.data()?.email as string | undefined
      setResolvedToken(token)
      if (inviteEmail) setEmail(inviteEmail)
      setEmailLocked(true)
      setInviteValidating('valid')
      setInviteError(null)
    } catch {
      setInviteValidating('error')
      setInviteError('Kunde inte kontrollera inbjudningskoden. Försök igen.')
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    const trimmedCompany = companyName.trim()
    const trimmedName    = userName.trim()
    const trimmedEmail   = email.trim()

    if (!(mode === 'invite') && !trimmedCompany) { setError('Company name is required.'); return }
    if (!trimmedName)                             { setError('Your name is required.'); return }
    if (!trimmedEmail)                            { setError('Email is required.'); return }
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

    try {
      await updateProfile(credential.user, { displayName: trimmedName })
    } catch {/* best-effort — Firestore writes are the source of truth */}

    try {
      await sendEmailVerification(credential.user)
    } catch {/* best-effort */}

    if (mode === 'invite') {
      // ── Invite path: accept invitation (no new company) ──────────────────
      // onUserCreate trigger also fires, but calling the callable gives us a
      // synchronous result we can act on immediately and gives a clear error
      // if the token is stale/mismatched before we create a session.
      try {
        const fns = getFunctions(auth.app, 'europe-west1')
        const accept = httpsCallable(fns, 'acceptInvitationByToken')
        await accept({ token: resolvedToken, name: trimmedName })
      } catch (inviteErr) {
        // Auth user was created but invite failed — clean up the orphan.
        await credential.user.delete().catch(() => {/* best-effort */})

        const msg = (inviteErr as { message?: string }).message ?? ''
        if (msg.includes('different email')) {
          setError('This invitation was sent to a different email address.')
        } else if (msg.includes('already been used') || msg.includes('not found')) {
          setError('This invitation link has already been used or is no longer valid.')
        } else {
          setError('Failed to accept the invitation. Please try again.')
        }
        setLoading(false)
        return
      }

      // Force-refresh token so custom claims (activeCompanyId) take effect.
      try {
        const freshToken = await credential.user.getIdToken(/* forceRefresh */ true)
        await createSession(freshToken)
      } catch {
        await credential.user.delete().catch(() => {/* best-effort */})
        setError('Failed to create session. Please try signing in.')
        setLoading(false)
        return
      }

      router.push('/verify-email')
      return
    }

    // ── Standard path: create company + session ────────────────────────────
    try {
      const idToken = await credential.user.getIdToken()
      await setupNewCompany(idToken, trimmedCompany, trimmedName)
    } catch (err) {
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

    // Force token refresh to pick up new claims, then create session.
    try {
      const freshToken = await credential.user.getIdToken(/* forceRefresh */ true)
      await createSession(freshToken)
    } catch {
      await credential.user.delete().catch(() => {/* best-effort */})
      setError('Failed to create session. Please try signing in.')
      setLoading(false)
      return
    }

    router.push('/verify-email')
  }

  // ── Mode: choose ──────────────────────────────────────────────────────────
  if (mode === 'choose') {
    return (
      <div className={styles.page}>
        <div className={styles.formCard}>
          <h1 className={styles.pageTitle}>CREATE ACCOUNT</h1>

          <div className={styles.modeCards}>
            <button
              className={styles.modeCard}
              type="button"
              onClick={() => setMode('create')}
            >
              Skapa ett nytt företag
            </button>
            <button
              className={styles.modeCard}
              type="button"
              onClick={() => setMode('invite')}
            >
              Jag har en inbjudningslänk
            </button>
          </div>

          <p className={styles.footer}>
            Already have an account?{' '}
            <Link href="/login">Sign in</Link>
          </p>
        </div>
      </div>
    )
  }

  // ── Mode: invite — manual token input step (no URL token yet) ─────────────
  if (mode === 'invite' && resolvedToken === null) {
    return (
      <div className={styles.page}>
        <div className={styles.formCard}>
          <h1 className={styles.pageTitle}>CREATE ACCOUNT</h1>

          <button
            className={styles.backLink}
            type="button"
            onClick={() => { setMode('choose'); setInviteError(null); setInviteValidating('idle') }}
          >
            ← Tillbaka
          </button>

          <div className={styles.form}>
            {inviteError && (
              <div className={styles.error} role="alert" aria-live="assertive">
                {inviteError}
              </div>
            )}

            <div className={styles.field}>
              <label className={styles.label} htmlFor="inviteInput">
                Inbjudningslänk eller kod
              </label>
              <input
                id="inviteInput"
                className={styles.input}
                type="text"
                value={inviteInput}
                onChange={(e) => setInviteInput(e.target.value)}
                disabled={inviteValidating === 'checking'}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleInviteValidation() } }}
              />
            </div>

            <button
              className={styles.submitBtn}
              type="button"
              disabled={inviteValidating === 'checking'}
              onClick={handleInviteValidation}
            >
              {inviteValidating === 'checking' ? 'Kontrollerar…' : 'Fortsätt'}
            </button>
          </div>

          <p className={styles.footer}>
            Already have an account?{' '}
            <Link href="/login">Sign in</Link>
          </p>
        </div>
      </div>
    )
  }

  // ── Mode: create OR invite with resolvedToken — show the full form ─────────
  return (
    <div className={styles.page}>
      <div className={styles.formCard}>
        <h1 className={styles.pageTitle}>CREATE ACCOUNT</h1>

        <button
          className={styles.backLink}
          type="button"
          onClick={() => {
            if (mode === 'invite') {
              // Go back to the token-input step (only for manually-entered tokens)
              setResolvedToken(null)
              setEmailLocked(false)
              setEmail('')
              setInviteValidating('idle')
              setInviteError(null)
            } else {
              setMode('choose')
            }
          }}
        >
          ← Tillbaka
        </button>

        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          {error && (
            <div className={styles.error} role="alert" aria-live="assertive">
              {error}
            </div>
          )}

          {!(mode === 'invite') && (
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
          )}

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
              disabled={loading || emailLocked}
              title={emailLocked ? 'E-post från din inbjudan' : undefined}
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
