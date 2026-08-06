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

/** Top-level mirror document at invitations/{token} */
export interface InvitationMirror {
  companyId: string
  inviteId: string
  email: string
  status: InvitationStatus
  expiresAt?: string      // ISO string — mirrors Invitation.expiresAt
}
