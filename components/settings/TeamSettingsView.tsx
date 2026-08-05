'use client'

import { useState } from 'react'
import { inviteUser, removeMember, updateMemberRole, revokeInvitation } from '@/actions/team'
import type { Role, TeamMember } from '@/types'
import type { Invitation } from '@/types/invitation'
import styles from './TeamSettingsView.module.css'

interface TeamSettingsViewProps {
  currentUserId: string
  pendingInvites: Invitation[]
  members: TeamMember[]
}

const ROLE_LABELS: Record<Role, string> = {
  admin:  'Admin',
  crew:   'Crew',
  viewer: 'Viewer',
}

export default function TeamSettingsView({ currentUserId, pendingInvites, members }: TeamSettingsViewProps) {
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)

  const [removeError, setRemoveError] = useState<string | null>(null)
  const [removing, setRemoving]       = useState<Record<string, boolean>>({})

  const [roleChanging, setRoleChanging] = useState<Record<string, boolean>>({})
  const [roleError, setRoleError] = useState<string | null>(null)

  // TODO(fas-2): restyle with the design's team table
  const [invites, setInvites] = useState(pendingInvites)
  const [revoking, setRevoking] = useState<Record<string, boolean>>({})
  const [revokeError, setRevokeError] = useState<string | null>(null)

  async function handleInvite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setInviting(true)
    setInviteError(null)

    const formData = new FormData()
    formData.set('email', inviteEmail)

    const result = await inviteUser(formData)

    setInviting(false)

    if (result.error) {
      setInviteError(result.error)
    } else {
      setInviteEmail('')
    }
  }

  async function handleRemove(memberId: string, memberName: string) {
    const confirmed = window.confirm(
      `Remove ${memberName} from the company? Their account is kept but they will lose access immediately.`,
    )
    if (!confirmed) return

    setRemoveError(null)
    setRemoving((prev) => ({ ...prev, [memberId]: true }))
    const result = await removeMember(memberId)
    setRemoving((prev) => ({ ...prev, [memberId]: false }))
    if (result.error) {
      setRemoveError(result.error)
    }
  }

  async function handleRoleChange(memberId: string, newRole: Role) {
    setRoleChanging((prev) => ({ ...prev, [memberId]: true }))
    setRoleError(null)
    const result = await updateMemberRole(memberId, newRole)
    setRoleChanging((prev) => ({ ...prev, [memberId]: false }))
    if (result.error) setRoleError(result.error)
  }

  async function handleRevoke(inviteId: string) {
    setRevokeError(null)
    setRevoking((prev) => ({ ...prev, [inviteId]: true }))
    const result = await revokeInvitation(inviteId)
    setRevoking((prev) => ({ ...prev, [inviteId]: false }))
    if (result.error) {
      setRevokeError(result.error)
    } else {
      setInvites((prev) => prev.filter((inv) => inv.id !== inviteId))
    }
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString()
  }

  return (
    <div className={styles.container}>
      <div className={styles.heading}>Settings</div>
      <div className={styles.subHeading}>Team</div>

      {/* Error banner for remove actions */}
      {removeError && (
        <div className={styles.errorBanner}>
          {removeError}
        </div>
      )}

      {roleError && (
        <div className={styles.errorBanner}>
          {roleError}
        </div>
      )}

      {/* Members table */}
      <div className={styles.sectionLabel}>Members</div>

      {members.length === 0 ? (
        <div className={styles.emptyState}>No members found.</div>
      ) : (
        <table className={styles.memberTable}>
          <thead>
            <tr>
              <th className={styles.th}>Name</th>
              <th className={styles.th}>Role</th>
              <th className={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const isCurrentUser = member.uid === currentUserId
              return (
                <tr key={member.uid} className={styles.memberRow}>
                  <td className={styles.td}>
                    <span className={styles.memberName}>{member.name}</span>
                    {isCurrentUser && (
                      <span className={styles.youTag}>You</span>
                    )}
                  </td>
                  <td className={styles.td}>
                    {isCurrentUser ? (
                      <span className={member.role === 'admin' ? styles.roleText : styles.roleTextMember}>
                        {ROLE_LABELS[member.role] ?? member.role}
                      </span>
                    ) : (
                      <select
                        className={styles.roleSelect}
                        value={member.role}
                        disabled={roleChanging[member.uid]}
                        onChange={(e) => handleRoleChange(member.uid, e.target.value as Role)}
                      >
                        <option value="admin">Admin</option>
                        <option value="crew">Crew</option>
                        <option value="viewer">Viewer</option>
                      </select>
                    )}
                  </td>
                  <td className={styles.tdAction}>
                    {!isCurrentUser && (
                      <button
                        className={styles.btnRemove}
                        onClick={() => handleRemove(member.uid, member.name)}
                        disabled={removing[member.uid]}
                        type="button"
                      >
                        {removing[member.uid] ? 'Removing…' : 'Remove'}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {/* Invite section */}
      <div className={styles.inviteSection}>
        <span className={styles.inviteLabel}>Invite by Email</span>

        {inviteError && (
          <div className={styles.errorBanner}>
            {inviteError}
          </div>
        )}

        <form onSubmit={handleInvite} className={styles.inviteForm}>
          <input
            type="email"
            className={styles.inviteInput}
            placeholder="colleague@example.com"
            value={inviteEmail}
            onChange={(e) => {
              setInviteEmail(e.target.value)
              setInviteError(null)
            }}
            required
          />
          <button
            type="submit"
            className={styles.btnInvite}
            disabled={inviting}
          >
            {inviting ? 'Sending…' : 'Send Invite'}
          </button>
        </form>

        <p className={styles.inviteNote}>
          Invited members will join as Crew by default.
        </p>
      </div>

      {/* Pending invitations — TODO(fas-2): restyle with the design's team table */}
      {invites.length > 0 && (
        <div className={styles.pendingSection}>
          <div className={styles.sectionLabel}>Pending Invitations</div>

          {revokeError && (
            <div className={styles.errorBanner}>
              {revokeError}
            </div>
          )}

          <ul className={styles.pendingList}>
            {invites.map((invite) => (
              <li key={invite.id} className={styles.pendingRow}>
                <span className={styles.pendingEmail}>{invite.email}</span>
                <span className={styles.pendingMeta}>
                  Sent {formatDate(invite.invitedAt)}
                  {invite.expiresAt ? ` · Expires ${formatDate(invite.expiresAt)}` : ''}
                </span>
                <button
                  className={styles.btnRemove}
                  onClick={() => handleRevoke(invite.id)}
                  disabled={revoking[invite.id]}
                  type="button"
                >
                  {revoking[invite.id] ? 'Revoking…' : 'Revoke'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
