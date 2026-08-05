'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { createUserWithEmailAndPassword, updateProfile } from 'firebase/auth'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { auth } from '@/lib/firebase'
import { setupNewCompany, createSession } from '@/actions/auth'
import { sendVerificationEmail } from '@/actions/auth-email'
import { validateInviteToken, type InviteValidation } from '@/actions/invitations'
import { TIMEZONE_OPTIONS } from '@/constants/company'
import AuthShell from './AuthShell'
import AuthCard from './AuthCard'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import Field from '@/components/ui/Field'
import Select from '@/components/ui/Select'
import ErrorBanner from '@/components/ui/ErrorBanner'
import PasswordMeter from '@/components/ui/PasswordMeter'
import styles from './SignupForm.module.css'

const MIN_PASSWORD_LENGTH = 8
const MIN_INVITE_INPUT_LENGTH = 20
const INVITE_DEBOUNCE_MS = 400

type Mode = 'create' | 'invite'
type InviteStatus = 'idle' | 'checking' | 'valid' | 'invalid'

// Extract an invite token from a redirect path like /invite/<token>
function extractInviteToken(redirect: string | null): string | null {
  if (!redirect) return null
  const match = redirect.match(/^\/invite\/([a-zA-Z0-9]{1,40})$/)
  return match ? match[1] : null
}

const INVALID_REASON_HINT: Record<Exclude<InviteValidation, { ok: true }>['reason'], string> = {
  malformed: "That doesn't look like an invitation link or code.",
  not_found: "We don't recognise this code",
  accepted:  'This invitation has already been used.',
  revoked:   'This invitation was withdrawn.',
  expired:   'This invitation has expired.',
}

/** Maps `acceptInvitationByToken`'s typed HttpsError codes to copy. Falls back to a message match for older/unexpected errors. */
function mapAcceptInviteError(err: unknown): string {
  const code = (err as { code?: string }).code ?? ''
  const message = (err as { message?: string }).message ?? ''

  switch (code) {
    case 'functions/permission-denied':
      return 'This invitation was sent to a different email address.'
    case 'functions/not-found':
      return 'This invitation link has already been used or is no longer valid.'
    case 'functions/already-exists':
      return 'You are already a member of this company.'
    case 'functions/deadline-exceeded':
      return 'This invitation has expired. Ask an admin to send a new one.'
    default:
      if (message.includes('different email')) {
        return 'This invitation was sent to a different email address.'
      }
      if (message.includes('already been used') || message.includes('not found')) {
        return 'This invitation link has already been used or is no longer valid.'
      }
      return 'Failed to accept the invitation. Please try again.'
  }
}

export default function SignupForm() {
  const router       = useRouter()
  const searchParams = useSearchParams()

  const redirectParam    = searchParams.get('redirect')
  const emailParam       = searchParams.get('email') ?? ''
  const inviteTokenParam = extractInviteToken(redirectParam)

  const [mode, setMode] = useState<Mode>(inviteTokenParam ? 'invite' : 'create')

  // ── Invite validation ─────────────────────────────────────────────────
  const [inviteInput,  setInviteInput]  = useState(inviteTokenParam ?? '')
  const [inviteStatus, setInviteStatus] = useState<InviteStatus>('idle')
  const [inviteResult, setInviteResult] = useState<InviteValidation | null>(null)
  const inviteRequestId = useRef(0)

  // Below the minimum length the field is treated as idle — derived at
  // render rather than written back via setState in the effect below, so a
  // shortened input can't trigger a synchronous cascading render.
  const inviteInputTooShort = inviteInput.trim().length < MIN_INVITE_INPUT_LENGTH
  const effectiveInviteStatus: InviteStatus = inviteInputTooShort ? 'idle' : inviteStatus

  useEffect(() => {
    if (mode !== 'invite') return

    const trimmed = inviteInput.trim()
    if (trimmed.length < MIN_INVITE_INPUT_LENGTH) return

    // Marks the field as checking as soon as a debounced lookup is scheduled.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInviteStatus('checking')
    const timer = setTimeout(() => {
      // Server actions can't be aborted — guard with a monotonic id so a slow
      // stale response can never overwrite a faster, more recent one.
      const id = ++inviteRequestId.current
      validateInviteToken(trimmed).then((result) => {
        if (id !== inviteRequestId.current) return
        setInviteResult(result)
        setInviteStatus(result.ok ? 'valid' : 'invalid')
      })
    }, INVITE_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [inviteInput, mode])

  const inviteValid   = effectiveInviteStatus === 'valid' && inviteResult?.ok === true
  const inviteInvalid = effectiveInviteStatus === 'invalid' && inviteResult?.ok === false

  // ── Shared form fields ───────────────────────────────────────────────
  const [timezone, setTimezone] = useState(() => {
    try {
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone
      return TIMEZONE_OPTIONS.some((o) => o.value === detected) ? detected : 'UTC'
    } catch {
      return 'UTC'
    }
  })

  const [companyName, setCompanyName] = useState('')
  const [userName,    setUserName]    = useState('')
  const [email,       setEmail]       = useState(emailParam)
  const [password,    setPassword]    = useState('')
  const [error,       setError]       = useState<string | null>(null)
  const [emailTaken,  setEmailTaken]  = useState(false)
  const [loading,     setLoading]     = useState(false)

  const effectiveEmail = mode === 'invite' && inviteValid && inviteResult?.ok ? inviteResult.email : email

  function switchMode(next: Mode) {
    setMode(next)
    setError(null)
    setEmailTaken(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setEmailTaken(false)

    if (mode === 'invite' && !inviteValid) return // CONTINUE is disabled in this state

    const trimmedCompany = companyName.trim()
    const trimmedName    = userName.trim()
    const trimmedEmail   = effectiveEmail.trim()

    if (mode === 'create' && !trimmedCompany) { setError('Company name is required.'); return }
    if (!trimmedName)                          { setError('Your name is required.'); return }
    if (!trimmedEmail)                         { setError('Email is required.'); return }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }

    setLoading(true)

    // ── Step 1: Create Firebase Auth user ──────────────────────────────
    let credential: Awaited<ReturnType<typeof createUserWithEmailAndPassword>>
    try {
      credential = await createUserWithEmailAndPassword(auth, trimmedEmail, password)
    } catch (err) {
      const code = (err as { code?: string }).code ?? ''
      if (code === 'auth/email-already-in-use') {
        setError(`${trimmedEmail} already has an account.`)
        setEmailTaken(true)
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
      await sendVerificationEmail(await credential.user.getIdToken())
    } catch {/* best-effort */}

    if (mode === 'invite') {
      // ── Invite path: accept invitation (no new company) ────────────────
      // onUserCreate trigger also fires, but calling the callable gives us a
      // synchronous result we can act on immediately and gives a clear error
      // if the token is stale/mismatched before we create a session.
      try {
        const fns = getFunctions(auth.app, 'europe-west1')
        const accept = httpsCallable(fns, 'acceptInvitationByToken')
        await accept({ token: inviteResult?.ok ? inviteResult.token : inviteInput.trim(), name: trimmedName })
      } catch (inviteErr) {
        // Auth user was created but invite failed — clean up the orphan.
        await credential.user.delete().catch(() => {/* best-effort */})
        setError(mapAcceptInviteError(inviteErr))
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

    // ── Standard path: create company + session ──────────────────────────
    try {
      const idToken = await credential.user.getIdToken()
      await setupNewCompany(idToken, trimmedCompany, trimmedName, timezone)
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

  const submitDisabled = loading || (mode === 'invite' && !inviteValid)
  const submitLabel = loading
    ? mode === 'invite'
      ? 'Joining…'
      : 'Creating account…'
    : mode === 'invite'
      ? inviteValid && inviteResult?.ok
        ? `Join ${inviteResult.companyName}`
        : 'Continue'
      : 'Create account'

  const FORM_ID = 'signup-form'

  // Rendered twice — once inline for desktop (hidden on mobile), once via
  // `AuthCard`'s `stickyActions` (hidden on desktop, fixed to the bottom on
  // mobile per the design's mobile files). `form={FORM_ID}` keeps the submit
  // button wired to the form even when it's not a DOM descendant of it.
  const actions = (
    <>
      <Button type="submit" form={FORM_ID} size="lg" fullWidth loading={loading} disabled={submitDisabled}>
        {submitLabel}
      </Button>
      {inviteInvalid && (
        <Button variant="secondary" size="lg" fullWidth type="button" onClick={() => switchMode('create')}>
          Start a new company instead
        </Button>
      )}
    </>
  )

  return (
    <AuthShell>
      <AuthCard width={440} gap={22} stickyActions={actions}>
        <h1 className={styles.title}>Create account</h1>

        <div className={styles.tabs}>
          <button
            type="button"
            className={`${styles.tab} ${mode === 'create' ? styles.tabActive : ''}`}
            onClick={() => switchMode('create')}
          >
            New company
          </button>
          <button
            type="button"
            className={`${styles.tab} ${mode === 'invite' ? styles.tabActive : ''}`}
            onClick={() => switchMode('invite')}
          >
            I have an invite
          </button>
        </div>

        <form id={FORM_ID} className={styles.form} onSubmit={handleSubmit} noValidate>
          {error && (
            <ErrorBanner
              tone="danger"
              action={
                emailTaken ? (
                  <Link className={styles.link} href="/login">
                    Sign in →
                  </Link>
                ) : undefined
              }
            >
              {error}
            </ErrorBanner>
          )}

          {mode === 'create' && (
            <div className={styles.createGrid}>
              <Field label="Company name" htmlFor="companyName" className={styles.spanTwo}>
                <Input
                  id="companyName"
                  inputSize="lg"
                  type="text"
                  autoComplete="organization"
                  maxLength={100}
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  required
                  disabled={loading}
                />
              </Field>

              <Field label="Your name" htmlFor="userName">
                <Input
                  id="userName"
                  inputSize="lg"
                  type="text"
                  autoComplete="name"
                  maxLength={100}
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  required
                  disabled={loading}
                />
              </Field>

              <Field label="Time zone" htmlFor="timezone">
                <Select
                  id="timezone"
                  selectSize="lg"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  disabled={loading}
                >
                  {TIMEZONE_OPTIONS.map(({ label, value }) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </Select>
              </Field>

              <Field label="Email" htmlFor="email" className={styles.spanTwo}>
                <Input
                  id="email"
                  inputSize="lg"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={loading}
                />
              </Field>

              <Field label="Password" htmlFor="password" className={styles.spanTwo}>
                <Input
                  id="password"
                  inputSize="lg"
                  type="password"
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={loading}
                />
                {password.length > 0 && (
                  <PasswordMeter strength={password.length >= MIN_PASSWORD_LENGTH ? 'ok' : 'weak'} />
                )}
              </Field>
            </div>
          )}

          {mode === 'invite' && (
            <div className={styles.inviteFields}>
              <Field
                label="Invitation code"
                htmlFor="inviteInput"
                hint={
                  inviteValid && inviteResult?.ok
                    ? { tone: 'accent', text: `Valid — ${inviteResult.companyName}, role ${inviteResult.role.toUpperCase()}` }
                    : inviteInvalid && inviteResult && !inviteResult.ok
                      ? { tone: 'danger', text: INVALID_REASON_HINT[inviteResult.reason] }
                      : undefined
                }
              >
                <Input
                  id="inviteInput"
                  inputSize="lg"
                  mono
                  type="text"
                  value={inviteInput}
                  onChange={(e) => setInviteInput(e.target.value)}
                  disabled={loading}
                  busy={effectiveInviteStatus === 'checking'}
                  invalid={inviteInvalid}
                />
              </Field>

              {inviteValid && inviteResult?.ok && (
                <div className={styles.inviteResolvedFields}>
                  <Field label="Email · locked to invite" htmlFor="inviteEmail">
                    <Input id="inviteEmail" inputSize="lg" value={inviteResult.email} locked />
                  </Field>

                  <Field label="Your name" htmlFor="userName">
                    <Input
                      id="userName"
                      inputSize="lg"
                      type="text"
                      autoComplete="name"
                      maxLength={100}
                      value={userName}
                      onChange={(e) => setUserName(e.target.value)}
                      required
                      disabled={loading}
                    />
                  </Field>

                  <Field label="Password" htmlFor="password">
                    <Input
                      id="password"
                      inputSize="lg"
                      type="password"
                      autoComplete="new-password"
                      placeholder="At least 8 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      disabled={loading}
                    />
                  </Field>
                </div>
              )}

              {inviteInvalid && (
                <span className={styles.explainer}>
                  Paste the full invitation link, or just the code at the end of it. Invitations
                  expire 7 days after they&apos;re sent — ask the admin to invite you again if
                  yours has expired.
                </span>
              )}
            </div>
          )}

          <div className={styles.desktopActions}>{actions}</div>
        </form>

        <span className={styles.legal}>
          By creating an account you agree to the <Link className={styles.link} href="/terms">terms of service</Link> and{' '}
          <Link className={styles.link} href="/privacy">privacy policy</Link>. Already have an account?{' '}
          <Link className={styles.link} href="/login">Sign in</Link>
        </span>
      </AuthCard>
    </AuthShell>
  )
}
