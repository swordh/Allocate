export type InvitationRole = 'admin' | 'crew'
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
}

/** Top-level mirror document at invitations/{token} */
export interface InvitationMirror {
  companyId: string
  inviteId: string
  email: string
  status: InvitationStatus
  expiresAt?: string      // ISO string — mirrors Invitation.expiresAt
}
