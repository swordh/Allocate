'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  checkActionCode,
  applyActionCode,
  confirmPasswordReset,
  signOut,
} from 'firebase/auth'
import { auth } from '@/lib/firebase'
import { createSession } from '@/actions/auth'
import AuthShell from './AuthShell'
import AuthCard from './AuthCard'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import Field from '@/components/ui/Field'
import ErrorBanner from '@/components/ui/ErrorBanner'
import PasswordMeter from '@/components/ui/PasswordMeter'
import DataRows from '@/components/ui/DataRows'
import styles from './AuthActionHandler.module.css'

const MIN_PASSWORD_LENGTH = 8
const RESOLVED_MODES = ['resetPassword', 'verifyEmail', 'verifyAndChangeEmail'] as const
type ResolvedMode = (typeof RESOLVED_MODES)[number]

// checkActionCode is read-only per the Firebase Auth SDK docs — it fetches
// the code's metadata (email/previousEmail) without consuming it. Only
// applyActionCode and confirmPasswordReset consume the oobCode. This is a
// distinct call from those, so it does not interact with the cba3ce3 gating
// that keeps the actual verify/reset action behind an explicit click.
type Phase =
  | { kind: 'loading' }
  | { kind: 'expired'; mode: ResolvedMode | null }
  | { kind: 'ready'; mode: ResolvedMode; email: string | null; previousEmail: string | null }
  | { kind: 'genericError'; message: string }

function errorMessage(err: unknown): string {
  const code = (err as { code?: string }).code ?? ''
  if (code === 'auth/invalid-action-code' || code === 'auth/expired-action-code') {
    return 'The link has expired or already been used. Request a new one.'
  }
  return 'Something went wrong. Please try again.'
}

function isExpiredCode(err: unknown): boolean {
  const code = (err as { code?: string }).code ?? ''
  return code === 'auth/invalid-action-code' || code === 'auth/expired-action-code'
}

export default function AuthActionHandler({
  mode,
  oobCode,
}: {
  mode?: string
  oobCode?: string
}) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })

  // Reset-password sub-state
  const [password, setPassword] = useState('')
  const [resetSubmitting, setResetSubmitting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)

  // Verify / change-email sub-state
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)

  useEffect(() => {
    const resolvedMode = RESOLVED_MODES.find((m) => m === mode) ?? null

    if (!oobCode || !resolvedMode) {
      setPhase({ kind: 'expired', mode: resolvedMode })
      return
    }

    checkActionCode(auth, oobCode)
      .then((info) => {
        setPhase({
          kind: 'ready',
          mode: resolvedMode,
          email: info.data.email ?? null,
          previousEmail: info.data.previousEmail ?? null,
        })
      })
      .catch((err) => {
        if (isExpiredCode(err)) {
          setPhase({ kind: 'expired', mode: resolvedMode })
        } else {
          setPhase({ kind: 'genericError', message: errorMessage(err) })
        }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleConfirm() {
    if (!oobCode || phase.kind !== 'ready') return
    const confirmMode = phase.mode
    setConfirming(true)
    setConfirmError(null)
    try {
      await applyActionCode(auth, oobCode)
      if (confirmMode === 'verifyEmail') {
        const user = auth.currentUser
        if (user) {
          const freshToken = await user.getIdToken(true)
          await createSession(freshToken)
          router.push('/bookings')
        } else {
          router.push('/login')
        }
      } else {
        await signOut(auth).catch(() => {})
        router.push('/login?emailChanged=1')
      }
    } catch (err) {
      setConfirmError(errorMessage(err))
      setConfirming(false)
    }
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!oobCode || password.length < MIN_PASSWORD_LENGTH) return
    setResetSubmitting(true)
    setResetError(null)
    try {
      await confirmPasswordReset(auth, oobCode, password)
      router.push('/login?passwordReset=1')
    } catch (err) {
      setResetError(errorMessage(err))
      setResetSubmitting(false)
    }
  }

  // ── loading ─────────────────────────────────────────────────────────
  if (phase.kind === 'loading') {
    return (
      <AuthShell>
        <AuthCard width={420} gap={24}>
          <h1 className={styles.title}>{mode === 'resetPassword' ? 'Reset password' : 'Verifying'}</h1>
        </AuthCard>
      </AuthShell>
    )
  }

  // ── expired ─────────────────────────────────────────────────────────
  if (phase.kind === 'expired') {
    // The desktop design shows no buttons for this card and the mobile file
    // gates its own button bar off for the expired state too (`hasButtons:
    // !expired`) — a dead end with no way out reads as an authoring bug in
    // the prototype, not intent, so both breakpoints get the mobile file's
    // computed SEND A NEW LINK / BACK TO SIGN IN pair here.
    const newLinkHref = phase.mode === 'resetPassword' ? '/forgot-password' : '/verify-email'
    const actions = (
      <>
        <Button size="lg" fullWidth onClick={() => router.push(newLinkHref)}>
          Send a new link
        </Button>
        <Button variant="secondary" size="lg" fullWidth onClick={() => router.push('/login')}>
          Back to sign in
        </Button>
      </>
    )
    return (
      <AuthShell>
        <AuthCard width={420} gap={24} stickyActions={actions}>
          <div className={styles.titleBlock}>
            <span className={styles.eyebrow}>Link expired</span>
            <h1 className={styles.title}>This link no longer works</h1>
            <span className={styles.body}>
              Links are valid for one hour and can only be used once. Request a new one and
              we&apos;ll email it straight away.
            </span>
          </div>
          <div className={styles.desktopActions}>{actions}</div>
        </AuthCard>
      </AuthShell>
    )
  }

  // ── generic error (not the design's expired card, e.g. a network hiccup) ─
  if (phase.kind === 'genericError') {
    return (
      <AuthShell>
        <AuthCard width={420} gap={24}>
          <h1 className={styles.title}>Something went wrong</h1>
          <ErrorBanner tone="danger">{phase.message}</ErrorBanner>
          <span className={styles.fineprint}>
            <Link className={styles.link} href="/login">Back to sign in</Link>
          </span>
        </AuthCard>
      </AuthShell>
    )
  }

  // ── ready: resetPassword ───────────────────────────────────────────
  if (phase.mode === 'resetPassword') {
    const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH
    const submitDisabled = resetSubmitting || password.length < MIN_PASSWORD_LENGTH
    const actions = (
      <Button size="lg" fullWidth loading={resetSubmitting} disabled={submitDisabled} form="reset-password-form" type="submit">
        Save new password
      </Button>
    )
    return (
      <AuthShell>
        <AuthCard width={420} gap={24} stickyActions={actions}>
          <div className={styles.titleBlock}>
            <h1 className={styles.title}>Set a new password</h1>
            <span className={styles.subtitle}>
              Link verified for <strong>{phase.email ?? 'your account'}</strong>. It can only be
              used once.
            </span>
          </div>

          {resetError && <ErrorBanner tone="danger">{resetError}</ErrorBanner>}

          <form id="reset-password-form" onSubmit={handlePasswordSubmit} noValidate>
            <Field
              label="New password"
              htmlFor="new-password"
              hint={
                tooShort
                  ? { tone: 'danger', text: 'Too short — use at least 8 characters' }
                  : { tone: 'neutral', text: 'At least 8 characters. Avoid a password you use elsewhere.' }
              }
            >
              <Input
                id="new-password"
                inputSize="lg"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={resetSubmitting}
                invalid={tooShort}
                autoComplete="new-password"
                autoFocus
              />
              {password.length > 0 && (
                <PasswordMeter strength={password.length >= MIN_PASSWORD_LENGTH ? 'ok' : 'weak'} />
              )}
            </Field>
          </form>

          <div className={styles.desktopActions}>{actions}</div>

          <span className={styles.fineprint}>
            Didn&apos;t request this? Close this page — <strong>your password stays unchanged</strong>.
          </span>
        </AuthCard>
      </AuthShell>
    )
  }

  // ── ready: verifyEmail ─────────────────────────────────────────────
  if (phase.mode === 'verifyEmail') {
    const actions = (
      <Button size="lg" fullWidth loading={confirming} onClick={handleConfirm}>
        Confirm address
      </Button>
    )
    return (
      <AuthShell>
        <AuthCard width={420} gap={24} stickyActions={actions}>
          <div className={styles.titleBlock}>
            <h1 className={styles.title}>Verify your address</h1>
            <span className={styles.body}>
              Confirm that <strong>{phase.email ?? 'this address'}</strong> belongs to you and
              we&apos;ll finish setting up your account.
            </span>
          </div>

          {confirmError && <ErrorBanner tone="danger">{confirmError}</ErrorBanner>}

          <div className={styles.desktopActions}>{actions}</div>

          <span className={styles.fineprint}>Didn&apos;t request this? Close this page — nothing changes.</span>
        </AuthCard>
      </AuthShell>
    )
  }

  // ── ready: verifyAndChangeEmail ────────────────────────────────────
  const actions = (
    <>
      <Button size="lg" fullWidth loading={confirming} onClick={handleConfirm}>
        Confirm change
      </Button>
      <Button variant="secondary" size="lg" fullWidth onClick={() => router.push('/login')} disabled={confirming}>
        Cancel, keep current
      </Button>
    </>
  )
  return (
    <AuthShell>
      <AuthCard width={420} gap={24} stickyActions={actions}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>New sign-in address</h1>
          <span className={styles.body}>
            Your bookings, role and workspace stay exactly as they are — only the address you
            sign in with changes.
          </span>
        </div>

        {confirmError && <ErrorBanner tone="danger">{confirmError}</ErrorBanner>}

        <DataRows
          variant="inline"
          rows={[
            { term: 'CURRENT', value: <span className={styles.strike}>{phase.previousEmail ?? '—'}</span> },
            { term: 'NEW', value: phase.email ?? '—' },
            { term: 'EXPIRES', value: <span className={styles.accentText}>Within one hour</span> },
          ]}
        />

        <div className={styles.desktopActions}>{actions}</div>
      </AuthCard>
    </AuthShell>
  )
}
