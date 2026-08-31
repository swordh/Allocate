import Link from 'next/link'
import { adminDb } from '@/lib/firebase-admin'
import { isInviteExpired } from '@/lib/invite-token'
import type { Invitation, InvitationMirror, InvitationRole } from '@/types'
import AuthShell from '@/components/auth/AuthShell'
import AuthCard from '@/components/auth/AuthCard'
import InviteAcceptClient, { type InviteServerState } from './InviteAcceptClient'
import styles from './InviteAccept.module.css'

interface InvitePageProps {
  params: Promise<{ token: string }>
}

const MS_PER_DAY = 1000 * 60 * 60 * 24

export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params

  // Read the top-level mirror — publicly readable (see firestore.rules)
  const mirrorSnap = await adminDb.collection('invitations').doc(token).get()

  if (!mirrorSnap.exists) {
    return <NotFoundCard />
  }

  const mirror = mirrorSnap.data() as InvitationMirror

  // Read the private document for role, invitedByName and expiresAt — the
  // mirror only carries companyId/inviteId/email/status/expiresAt. A missing
  // private doc alongside a pending mirror is a data inconsistency; treat it
  // the same as a missing mirror rather than rendering with guessed values.
  const inviteSnap = await adminDb.doc(`companies/${mirror.companyId}/invitations/${mirror.inviteId}`).get()

  if (!inviteSnap.exists) {
    return <NotFoundCard />
  }

  const invite = inviteSnap.data() as Invitation

  const companySnap = await adminDb.doc(`companies/${mirror.companyId}`).get()
  const companyName: string = companySnap.exists
    ? ((companySnap.data()?.name as string) ?? 'a company')
    : 'a company'

  const expiresAt = invite.expiresAt ?? mirror.expiresAt
  const expired = mirror.status === 'pending' && isInviteExpired(expiresAt)

  const state: InviteServerState =
    mirror.status === 'revoked'
      ? 'revoked'
      : mirror.status === 'accepted'
        ? 'accepted'
        : expired
          ? 'expired'
          : 'valid'

  const daysLeft =
    state === 'valid' && expiresAt
      ? Math.max(1, Math.ceil((Date.parse(expiresAt) - Date.now()) / MS_PER_DAY))
      : null

  return (
    <InviteAcceptClient
      token={token}
      state={state}
      companyName={companyName}
      invitedEmail={mirror.email}
      role={invite.role as InvitationRole}
      inviterName={invite.invitedByName}
      daysLeft={daysLeft}
      revokedAt={invite.revokedAt}
      acceptedAt={invite.acceptedAt}
    />
  )
}

// ── Not-found card ────────────────────────────────────────────────────────
// Rendered server-side; no interactivity needed. Same reason string as
// before the redesign — the token doesn't resolve to a real invitation
// (missing mirror, or a mirror pointing at a private doc that doesn't exist).

function NotFoundCard() {
  return (
    <AuthShell>
      <AuthCard width={440} gap={24}>
        <div className={styles.titleBlock}>
          <span className={`${styles.eyebrow} ${styles.eyebrowDanger}`}>INVITATION NOT FOUND</span>
          <h1 className={styles.title}>Invalid link</h1>
          <span className={styles.lede}>
            This invitation link is invalid or has expired. Ask whoever invited you to send a new one.
          </span>
        </div>
        <Link className={styles.btnPrimary} href="/login">
          Go to sign in
        </Link>
      </AuthCard>
    </AuthShell>
  )
}
