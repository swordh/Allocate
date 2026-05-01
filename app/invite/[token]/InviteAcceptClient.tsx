'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { useAuth } from '@/lib/auth-context'
import { createSession } from '@/actions/auth'
import { auth } from '@/lib/firebase'
import styles from './InvitePage.module.css'

interface Props {
  token: string
  companyName: string
  email: string
}

/**
 * Rendered when the invite mirror doc is valid and pending.
 *
 * - If the user is already signed in → call acceptInvitationByToken directly,
 *   force-refresh the token, re-issue the session cookie, then redirect to /.
 * - If the user is not signed in → show Sign in / Create account CTAs.
 */
export default function InviteAcceptClient({ token, companyName, email }: Props) {
  const router         = useRouter()
  const { user, loading: authLoading } = useAuth()

  const [status, setStatus] = useState<'idle' | 'accepting' | 'done' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    // Only run once auth state is resolved and the user is signed in.
    if (authLoading || !user || status !== 'idle') return

    setStatus('accepting')

    ;(async () => {
      try {
        const fns    = getFunctions(auth.app, 'europe-west1')
        const accept = httpsCallable(fns, 'acceptInvitationByToken')
        await accept({ token })

        // Force-refresh so updated claims (activeCompanyId) are in the new cookie.
        const freshToken = await user.getIdToken(/* forceRefresh */ true)
        await createSession(freshToken)

        setStatus('done')
        router.push('/')
      } catch (err) {
        const msg = (err as { message?: string }).message ?? ''

        if (msg.includes('already a member')) {
          // Already a member — redirect silently.
          setStatus('done')
          router.push('/')
          return
        }

        if (msg.includes('different email')) {
          setErrorMsg(`This invitation was sent to ${email}. Please sign in with that address.`)
        } else if (msg.includes('already been used') || msg.includes('not found')) {
          setErrorMsg('This invitation link has already been used or is no longer valid.')
        } else {
          setErrorMsg('Failed to accept the invitation. Please try again.')
        }
        setStatus('error')
      }
    })()
  }, [authLoading, user, status, token, email, router])

  // ── Already signed in: show progress/result ──────────────────────────────
  if (!authLoading && user) {
    if (status === 'accepting' || status === 'idle') {
      return (
        <div className={styles.card}>
          <p className={styles.label}>Accepting invitation…</p>
          <h1 className={styles.companyName}>{companyName}</h1>
        </div>
      )
    }

    if (status === 'error') {
      return (
        <div className={styles.card}>
          <p className={styles.invalidLabel}>Could not accept invitation</p>
          <p className={styles.invalidReason}>{errorMsg}</p>
          <Link href="/" className={styles.btnPrimary}>Go to app</Link>
        </div>
      )
    }

    // 'done' — router.push already fired, show nothing meaningful.
    return null
  }

  // ── Auth state still loading ─────────────────────────────────────────────
  if (authLoading) {
    return (
      <div className={styles.card}>
        <p className={styles.label}>Loading…</p>
        <h1 className={styles.companyName}>{companyName}</h1>
      </div>
    )
  }

  // ── Not signed in: show CTAs ─────────────────────────────────────────────
  return (
    <div className={styles.card}>
      <p className={styles.label}>You have been invited to join</p>
      <h1 className={styles.companyName}>{companyName}</h1>
      <p className={styles.email}>Invitation sent to {email}</p>

      <div className={styles.actions}>
        <Link
          href={`/login?redirect=/invite/${token}&email=${encodeURIComponent(email)}`}
          className={styles.btnPrimary}
        >
          Sign in to accept
        </Link>
        <Link
          href={`/signup?redirect=/invite/${token}&email=${encodeURIComponent(email)}`}
          className={styles.btnSecondary}
        >
          Create an account
        </Link>
      </div>

      <p className={styles.note}>
        After signing in, your membership will be activated automatically.
      </p>
    </div>
  )
}
