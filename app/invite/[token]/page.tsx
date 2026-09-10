import { redirect } from 'next/navigation'
import { adminAuth, adminDb } from '@/lib/firebase-admin'
import { isInviteExpired } from '@/lib/invite-token'
import type { Invitation, InvitationMirror, InvitationRole } from '@/types'
import InviteAcceptClient from './InviteAcceptClient'

interface InvitePageProps {
  params: Promise<{ token: string }>
}

const MS_PER_DAY = 1000 * 60 * 60 * 24

// Every terminal case below — missing mirror, missing private doc, revoked,
// accepted, expired — sends the visitor to one case-agnostic "link no longer
// valid" page instead of a distinct card per reason (see app/invite/invalid).
// `redirect()` throws internally, so none of these call sites sit inside a
// try/catch here — nothing in this file would swallow that throw.
const INVALID_INVITE_PATH = '/invite/invalid'

export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params

  // Read the top-level mirror — publicly readable (see firestore.rules)
  const mirrorSnap = await adminDb.collection('invitations').doc(token).get()

  if (!mirrorSnap.exists) {
    redirect(INVALID_INVITE_PATH)
  }

  const mirror = mirrorSnap.data() as InvitationMirror

  // Read the private document for role, invitedByName and expiresAt — the
  // mirror only carries companyId/inviteId/email/status/expiresAt. A missing
  // private doc alongside a pending mirror is a data inconsistency; treat it
  // the same as a missing mirror rather than rendering with guessed values.
  const inviteSnap = await adminDb.doc(`companies/${mirror.companyId}/invitations/${mirror.inviteId}`).get()

  if (!inviteSnap.exists) {
    redirect(INVALID_INVITE_PATH)
  }

  const invite = inviteSnap.data() as Invitation

  const companySnap = await adminDb.doc(`companies/${mirror.companyId}`).get()
  const companyName: string = companySnap.exists
    ? ((companySnap.data()?.name as string) ?? 'a company')
    : 'a company'

  const expiresAt = invite.expiresAt ?? mirror.expiresAt
  const expired = mirror.status === 'pending' && isInviteExpired(expiresAt)

  if (mirror.status === 'revoked' || mirror.status === 'accepted' || expired) {
    redirect(INVALID_INVITE_PATH)
  }

  const daysLeft = expiresAt ? Math.max(1, Math.ceil((Date.parse(expiresAt) - Date.now()) / MS_PER_DAY)) : null

  // A valid, still-pending invite is the only case that reaches the client
  // component, so this lookup always applies now — unlike before, when it
  // was guarded behind a `state === 'valid'` check. Keyed off the token (not
  // a public email field), so this doesn't open a way to probe arbitrary
  // addresses.
  let accountExists: boolean | null = null
  try {
    await adminAuth.getUserByEmail(mirror.email)
    accountExists = true
  } catch (err) {
    if ((err as { code?: string }).code === 'auth/user-not-found') {
      accountExists = false
    } else {
      // Unknown/transient Auth error — fall back to `null` so the client
      // renders both CTAs rather than guessing wrong and hiding the one
      // the visitor actually needs.
      console.warn('[invite] getUserByEmail lookup failed', err)
      accountExists = null
    }
  }

  return (
    <InviteAcceptClient
      token={token}
      companyName={companyName}
      invitedEmail={mirror.email}
      role={invite.role as InvitationRole}
      inviterName={invite.invitedByName}
      daysLeft={daysLeft}
      accountExists={accountExists}
    />
  )
}
