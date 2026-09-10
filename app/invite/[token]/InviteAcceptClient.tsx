'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { signOut } from 'firebase/auth'
import { getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions'
import { useAuth } from '@/lib/auth-context'
import { createSession, deleteSession } from '@/actions/auth'
import { auth } from '@/lib/firebase'
import AuthShell from '@/components/auth/AuthShell'
import AuthCard from '@/components/auth/AuthCard'
import Button from '@/components/ui/Button'
import Chip from '@/components/ui/Chip'
import ErrorBanner from '@/components/ui/ErrorBanner'
import type { InvitationRole } from '@/types'
import styles from './InviteAccept.module.css'

interface Props {
  token: string
  companyName: string
  invitedEmail: string
  role: InvitationRole
  inviterName: string
  /** Null when the invitation predates the TTL field — such invites never expire. */
  daysLeft: number | null
  /**
   * Whether a Firebase Auth account already exists for `invitedEmail`, resolved
   * server-side in page.tsx. `null` means the lookup failed transiently — we
   * keep showing both CTAs rather than risk hiding the one the visitor
   * actually needs.
   */
  accountExists: boolean | null
}

/**
 * Maps the callable's typed HttpsError codes. `acceptInvitationByToken` has
 * always thrown these; the pre-redesign code matched on message substrings
 * instead, which broke silently whenever the copy changed.
 */
function acceptErrorMessage(err: unknown): { message: string; alreadyMember: boolean } {
  const code = (err as FunctionsError)?.code
  const raw = (err as { message?: string }).message ?? ''

  if (code === 'functions/already-exists' || raw.includes('already a member')) {
    return { message: '', alreadyMember: true }
  }
  if (code === 'functions/deadline-exceeded' || raw.includes('expired')) {
    return { message: 'This invitation has expired. Ask an admin to send a new one.', alreadyMember: false }
  }
  if (code === 'functions/permission-denied' || raw.includes('different email')) {
    return { message: 'This invitation was sent to a different email address.', alreadyMember: false }
  }
  if (code === 'functions/not-found' || raw.includes('already been used') || raw.includes('not found')) {
    return { message: 'This invitation link has already been used or is no longer valid.', alreadyMember: false }
  }
  return { message: 'We couldn’t accept the invitation. Try again.', alreadyMember: false }
}

export default function InviteAcceptClient({
  token,
  companyName,
  invitedEmail,
  role,
  inviterName,
  daysLeft,
  accountExists,
}: Props) {
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()

  const [accepting, setAccepting] = useState(false)
  const [acceptError, setAcceptError] = useState<string | null>(null)

  // The signed-in address decides between `accepting` and `wrongAccount`. We
  // check it here rather than letting the callable reject, which saves a
  // round-trip and lets the mismatch render as its own designed card.
  const signedInEmail = user?.email ?? null
  const emailMatches =
    signedInEmail !== null && signedInEmail.toLowerCase() === invitedEmail.toLowerCase()

  const canAutoAccept = !authLoading && user !== null && emailMatches

  useEffect(() => {
    if (!canAutoAccept || accepting || acceptError) return

    setAccepting(true)
    ;(async () => {
      try {
        const fns = getFunctions(auth.app, 'europe-west1')
        await httpsCallable(fns, 'acceptInvitationByToken')({ token })

        // Force-refresh so the new activeCompanyId claim lands in the cookie.
        const freshToken = await user!.getIdToken(true)
        await createSession(freshToken)
        router.push('/bookings')
      } catch (err) {
        const { message, alreadyMember } = acceptErrorMessage(err)
        if (alreadyMember) {
          router.push('/bookings')
          return
        }
        setAcceptError(message)
        setAccepting(false)
      }
    })()
  }, [canAutoAccept, accepting, acceptError, token, user, router])

  const handleSignOut = useCallback(async () => {
    await signOut(auth)
    await deleteSession()
    router.refresh()
  }, [router])

  const wrongAccount = !authLoading && user !== null && !emailMatches

  const eyebrow = canAutoAccept ? 'JOINING WORKSPACE' : "YOU'VE BEEN INVITED"

  // ── Wrong account ─────────────────────────────────────────────────────────
  if (wrongAccount) {
    return (
      <AuthShell>
        <AuthCard width={440} gap={24}>
          <div className={styles.titleBlock}>
            <span className={styles.eyebrow}>{eyebrow}</span>
            <h1 className={styles.title}>{companyName}</h1>
          </div>

          <ErrorBanner tone="danger">
            You&rsquo;re signed in as <strong className={styles.strong}>{signedInEmail}</strong>, but
            this invitation is for {invitedEmail}.
          </ErrorBanner>

          <p className={styles.body}>
            Sign out and open the link again with the invited address, or ask {inviterName} to
            reissue the invitation to {signedInEmail}.
          </p>

          <div className={styles.actions}>
            <Button size="lg" fullWidth onClick={handleSignOut}>
              Sign out and continue
            </Button>
            <Link className={styles.linkSecondary} href="/bookings">
              Stay signed in
            </Link>
          </div>
        </AuthCard>
      </AuthShell>
    )
  }

  // ── Accepting (signed in, address matches) ────────────────────────────────
  if (canAutoAccept) {
    return (
      <AuthShell>
        <AuthCard width={440} gap={22}>
          <div className={styles.titleBlock}>
            <span className={styles.eyebrow}>{eyebrow}</span>
            <h1 className={styles.title}>{companyName}</h1>
          </div>

          <p className={styles.body}>
            The address matches the invitation, so we&rsquo;re accepting it for you and opening the
            bookings view.
          </p>

          {acceptError ? (
            <ErrorBanner tone="danger">{acceptError}</ErrorBanner>
          ) : (
            <ErrorBanner tone="info">Accepting invitation…</ErrorBanner>
          )}

          <p className={styles.fineprint}>
            Not you?{' '}
            <button type="button" className={styles.inlineLink} onClick={handleSignOut}>
              Sign out
            </button>{' '}
            and open the link again with the invited address.
          </p>
        </AuthCard>
      </AuthShell>
    )
  }

  // ── Auth still resolving ──────────────────────────────────────────────────
  if (authLoading) {
    return (
      <AuthShell>
        <AuthCard width={440} gap={24}>
          <div className={styles.titleBlock}>
            <span className={styles.eyebrow}>{eyebrow}</span>
            <h1 className={styles.title}>{companyName}</h1>
          </div>
        </AuthCard>
      </AuthShell>
    )
  }

  // ── Valid, signed out ─────────────────────────────────────────────────────
  const redirect = `/invite/${token}`
  const emailParam = encodeURIComponent(invitedEmail)

  return (
    <AuthShell>
      <AuthCard width={440} gap={24}>
        <div className={styles.titleBlock}>
          <span className={styles.eyebrow}>{eyebrow}</span>
          <h1 className={styles.title}>{companyName}</h1>
          <span className={styles.lede}>
            {inviterName} invited <strong className={styles.strong}>{invitedEmail}</strong> to join
            as {role}
            {/* Explicit string: the compiler drops the leading space of a text
                chunk that starts right after an expression, rendering "crew—". */}
            {' — '}
            you&rsquo;ll be able to create and manage bookings.
          </span>
        </div>

        <div className={styles.chips}>
          <Chip interactive={false} size="tag">
            ROLE · {role.toUpperCase()}
          </Chip>
          {/* Hidden for invitations created before the TTL field existed —
              they never expire, so claiming a deadline would be a lie. */}
          {daysLeft !== null && (
            <Chip interactive={false} size="tag" tone="accent">
              EXPIRES IN {daysLeft} {daysLeft === 1 ? 'DAY' : 'DAYS'}
            </Chip>
          )}
        </div>

        {/* We only know which CTA applies once we know whether an Auth account
            already exists for the invited address — accountExists === null
            means that lookup was skipped or failed, so fall back to showing
            both rather than guessing and hiding the one the visitor needs. */}
        <div className={styles.actions}>
          {accountExists !== false && (
            <Link
              className={styles.linkPrimary}
              href={`/login?redirect=${redirect}&email=${emailParam}`}
            >
              Sign in to accept
            </Link>
          )}
          {accountExists !== true && (
            <Link
              className={accountExists === false ? styles.linkPrimary : styles.linkSecondary}
              href={`/signup?redirect=${redirect}&email=${emailParam}`}
            >
              Create an account
            </Link>
          )}
        </div>

        <p className={styles.fineprint}>
          The invitation is tied to {invitedEmail}. Signing in with another address won&rsquo;t
          accept it.
        </p>
      </AuthCard>
    </AuthShell>
  )
}
