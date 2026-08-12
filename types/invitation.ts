import type { Role } from './user'

// Full Role union — the design's invite form offers ADMIN / CREW / VIEWER,
// so 'viewer' is invitable like the other two roles.
export type InvitationRole = Role
export type InvitationStatus = 'pending' | 'accepted' | 'revoked'

export interface Invitation {
  id: string
  email: string
  role: InvitationRole
  invitedBy: string
  invitedByName: string
  invitedAt: string       // ISO string
  status: InvitationStatus
  token: string
  acceptedAt?: string     // ISO string
  acceptedBy?: string     // uid
  expiresAt?: string      // ISO string — missing means "never expires" (backward compat)
  revokedAt?: string      // ISO string
  revokedBy?: string      // uid of the admin who revoked it
  lastSentAt?: string     // ISO string — set on invite creation and every resend, so the
                          // UI can render "Invite re-sent just now"
}

/**
 * Invitation shape safe to hand to the client. The token is the credential
 * in the accept link — `revokeInvitation`/`resendInvitation` take an invite
 * id and read the token server-side, so the UI never needs it. Used as the
 * return shape from `inviteUser` (actions/team.ts) and as the pending-list
 * item type in `TeamSettingsView`.
 */
export type PublicInvitation = Omit<Invitation, 'token'>

/** Top-level mirror document at invitations/{token} */
export interface InvitationMirror {
  companyId: string
  inviteId: string
  email: string
  status: InvitationStatus
  expiresAt?: string      // ISO string — mirrors Invitation.expiresAt
}
