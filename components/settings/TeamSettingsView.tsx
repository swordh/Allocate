'use client'

import { useState } from 'react'
import { useMembers } from '@/hooks/useMembers'
import { inviteUser, removeMember } from '@/actions/team'
import type { Role } from '@/types'
import styles from './TeamSettingsView.module.css'

interface TeamSettingsViewProps {
  companyId: string
  currentUserId: string
}

const ROLE_LABELS: Record<Role, string> = {
  admin:  'Admin',
  crew:   'Crew',
  viewer: 'Viewer',
}

export default function TeamSettingsView({ companyId, currentUserId }: TeamSettingsViewProps) {
  const { members, loading } = useMembers(companyId)

  const [inviteEmail, setInviteEmail] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)

  const [removeError, setRemoveError] = useState<string | null>(null)

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

  async function handleRemove(memberId: string) {
    setRemoveError(null)
    const result = await removeMember(memberId)
    if (result.error) {
      setRemoveError(result.error)
    }
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

      {/* Members table */}
      <div className={styles.sectionLabel}>Members</div>

      {loading ? (
        <div className={styles.loadingState}>Loading members…</div>
      ) : members.length === 0 ? (
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
                    <span className={styles.roleText}>
                      {ROLE_LABELS[member.role] ?? member.role}
                    </span>
                  </td>
                  <td className={styles.tdAction}>
                    {!isCurrentUser && (
                      <button
                        className={styles.btnRemove}
                        onClick={() => handleRemove(member.uid)}
                        type="button"
                      >
                        Remove
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
    </div>
  )
}
