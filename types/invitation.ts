import type { Timestamp } from 'firebase-admin/firestore'
import type { Role } from './user'

// Full Role union — the design's invite form offers ADMIN / CREW, so both
// are invitable.
export type InvitationRole = Role
export type InvitationStatus = 'pending' | 'accepted' | 'revoked'

export interface Invitation {
  id: string
  email: string | null    // null after anonymizeMemberReferences clears an accepted invite's
                           // acceptedBy (actions/team.ts, issue #419)
  role: InvitationRole
  invitedBy: string | null      // null after the inviter is removed/leaves (issue #419)
  invitedByName: string | null  // null after the inviter is removed/leaves (issue #419)
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
  /**
   * Firestore TTL field (issue #297), set to the same instant as
   * `expiresAt`. Missing on a mirror written before this field existed,
   * until `tools/backfill_invitation_mirrors.js` runs.
   *
   * The TTL policy (`firestore.indexes.json` `fieldOverrides`) is scoped to
   * the `invitations` COLLECTION GROUP, so it also matches every
   * `companies/{cid}/invitations/*` private doc — this field must NEVER be
   * added to `Invitation` above, and must never be renamed to `expiresAt`
   * (the private doc's own field), or a private invitation record would be
   * silently TTL-deleted.
   */
  expireAt?: Timestamp
}
