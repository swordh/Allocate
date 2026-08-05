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
import DataRows from '@/components/ui/DataRows'
import type { InvitationRole } from '@/types'
import styles from './InviteAccept.module.css'

/** Resolved server-side in page.tsx from the mirror + private invitation doc. */
export type InviteServerState = 'valid' | 'accepted' | 'expired' | 'revoked'

interface Props {
  token: string
  state: InviteServerState
  companyName: string
  invitedEmail: string
  role: InvitationRole
  inviterName: string
  /** Null when the invitation predates the TTL field — such invites never expire. */
  daysLeft: number | null
  revokedAt?: string
  acceptedAt?: string
}

/** "Revoked Jul 26" — the design's format. Falls back to a bare label when the
 *  timestamp is missing (invitations revoked before revokedAt existed). */
function revokedLabel(revokedAt?: string): string {
  if (!revokedAt) return 'Revoked'
  const parsed = Date.parse(revokedAt)
  if (Number.isNaN(parsed)) return 'Revoked'
  const when = new Date(parsed).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })
  return `Revoked ${when}`
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
  state,
  companyName,
  invitedEmail,
  role,
  inviterName,
  daysLeft,
  revokedAt,
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

  const canAutoAccept = state === 'valid' && !authLoading && user !== null && emailMatches

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

  const revoked = state === 'revoked'
  const wrongAccount = state === 'valid' && !authLoading && user !== null && !emailMatches

  const eyebrow = revoked
    ? 'INVITATION WITHDRAWN'
    : canAutoAccept
      ? 'JOINING WORKSPACE'
      : "YOU'VE BEEN INVITED"

  // ── Revoked ───────────────────────────────────────────────────────────────
  if (revoked) {
    return (
      <AuthShell>
        <AuthCard width={440} gap={24}>
          <div className={styles.titleBlock}>
            <span className={`${styles.eyebrow} ${styles.eyebrowDanger}`}>{eyebrow}</span>
            <h1 className={styles.title}>{companyName}</h1>
            <span className={styles.lede}>
              An admin cancelled this invitation before it was accepted. Ask {inviterName} to send a
              new one — nothing was created on your side.
            </span>
          </div>

          <DataRows
            variant="inline"
            termWidth={130}
            rows={[
              { term: 'ADDRESS', value: invitedEmail },
              {
                term: 'STATUS',
                value: <span className={styles.statusDanger}>{revokedLabel(revokedAt)}</span>,
              },
            ]}
          />

          <div className={styles.actions}>
            <Link className={styles.linkPrimary} href="/login">
              Go to sign in
            </Link>
            <Link className={styles.linkSecondary} href="/signup">
              Create a new company
            </Link>
          </div>
        </AuthCard>
      </AuthShell>
    )
  }

  // ── Expired / already accepted ────────────────────────────────────────────
  if (state === 'expired' || state === 'accepted') {
    const expired = state === 'expired'
    return (
      <AuthShell>
        <AuthCard width={440} gap={24}>
          <div className={styles.titleBlock}>
            <span className={`${styles.eyebrow} ${styles.eyebrowDanger}`}>
              {expired ? 'INVITATION EXPIRED' : 'ALREADY ACCEPTED'}
            </span>
            <h1 className={styles.title}>{companyName}</h1>
            <span className={styles.lede}>
              {expired
                ? `This invitation is no longer valid. Ask ${inviterName} to send a new one.`
                : 'This invitation has already been used. Sign in with the account you created.'}
            </span>
          </div>

          <div className={styles.actions}>
            <Link className={styles.linkPrimary} href="/login">
              Go to sign in
            </Link>
          </div>
        </AuthCard>
      </AuthShell>
    )
  }

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
            as {role} — you&rsquo;ll be able to create and manage bookings.
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

        <div className={styles.actions}>
          <Link
            className={styles.linkPrimary}
            href={`/login?redirect=${redirect}&email=${emailParam}`}
          >
            Sign in to accept
          </Link>
          <Link
            className={styles.linkSecondary}
            href={`/signup?redirect=${redirect}&email=${emailParam}`}
          >
            Create an account
          </Link>
        </div>

        <p className={styles.fineprint}>
          The invitation is tied to {invitedEmail}. Signing in with another address won&rsquo;t
          accept it.
        </p>
      </AuthCard>
    </AuthShell>
  )
}
