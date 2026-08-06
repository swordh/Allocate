'use client'

import { useState } from 'react'
import { inviteUser, removeMember, updateMemberRole, revokeInvitation, resendInvitation } from '@/actions/team'
import { inviteMeta, daysLeftFrom } from '@/lib/invite-status'
import Chip from '@/components/ui/Chip'
import Input from '@/components/ui/Input'
import Button from '@/components/ui/Button'
import ErrorBanner from '@/components/ui/ErrorBanner'
import ConfirmDialog from '@/components/ui/ConfirmDialog'
import EmptyState from '@/components/ui/EmptyState'
import Icon from '@/components/ui/Icon'
import type { Role, TeamMember } from '@/types'
import type { PublicInvitation } from '@/types/invitation'
import styles from './TeamSettingsView.module.css'

interface TeamSettingsViewProps {
  currentUserId: string
  pendingInvites: PublicInvitation[]
  members: TeamMember[]
  /** members + active (non-expired) pending invites — matches inviteUser's seat guard exactly. */
  seatsUsed: number
  /** subscription.limits.users, or null if the field is missing. */
  seatLimit: number | null
}

const ROLES: Role[] = ['admin', 'crew', 'viewer']
const ROLE_LABELS: Record<Role, string> = { admin: 'Admin', crew: 'Crew', viewer: 'Viewer' }

/** Below this, an inline confirm renders inside the member card instead of the ConfirmDialog. Matches the CSS breakpoint. */
const MOBILE_BREAKPOINT = 768

/** Same "does this still count against the seat guard" rule as page.tsx / actions/team.ts. */
function isInviteActive(invite: Pick<PublicInvitation, 'expiresAt'>): boolean {
  return !invite.expiresAt || Date.parse(invite.expiresAt) > Date.now()
}

function formatJoined(iso: string): string {
  if (!iso) return ''
  return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(new Date(iso))
}

/**
 * Colour for a pending row's meta text. `inviteMeta`'s state alone can't
 * distinguish "sent recently, plenty of time left" from "sent a while ago,
 * expiring soon" — both are just `state: 'active'`. Judgement call: treat
 * 3 days or fewer remaining as the same visual urgency as an outright
 * expired invite (--warn-muted), matching the design's hand-picked demo
 * values (a 2-day-left invite was flagged `warn`, a fresh one was not).
 */
function pendingMetaColor(invite: PublicInvitation, state: ReturnType<typeof inviteMeta>['state']): string {
  if (state === 'resent') return 'var(--accent)'
  if (state === 'expired') return 'var(--warn-muted)'
  if (invite.expiresAt && daysLeftFrom(invite.expiresAt) <= 3) return 'var(--warn-muted)'
  return 'var(--text-weak)'
}

/** Mobile card's left accent bar — same urgency signal as the meta text colour, but never text-weak (falls back to the neutral border shade). */
function pendingAccentColor(invite: PublicInvitation, state: ReturnType<typeof inviteMeta>['state']): string {
  const color = pendingMetaColor(invite, state)
  return color === 'var(--text-weak)' ? 'var(--border-medium)' : color
}

const ROLE_ACCENT: Record<Role, string> = {
  admin: 'var(--accent)',
  crew: 'var(--text-bright)',
  viewer: 'var(--border-medium)',
}

export default function TeamSettingsView({
  currentUserId,
  pendingInvites,
  members: initialMembers,
  seatsUsed: initialSeatsUsed,
  seatLimit,
}: TeamSettingsViewProps) {
  const [members, setMembers] = useState(initialMembers)
  const [invites, setInvites] = useState(pendingInvites)
  const [seatsUsed, setSeatsUsed] = useState(initialSeatsUsed)

  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<Role>('crew')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)

  const [roleChanging, setRoleChanging] = useState<Record<string, boolean>>({})
  const [roleError, setRoleError] = useState<string | null>(null)

  // Desktop uses the ConfirmDialog; mobile inlines the confirm in the card.
  // Which one opens is decided at click time from viewport width (see
  // handleAskRemove) — the two states are mutually exclusive.
  const [removeTarget, setRemoveTarget] = useState<TeamMember | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const [resending, setResending] = useState<Record<string, boolean>>({})
  const [resent, setResent] = useState<Record<string, boolean>>({})
  const [revoking, setRevoking] = useState<Record<string, boolean>>({})
  const [revokeError, setRevokeError] = useState<string | null>(null)

  const seatCopy = seatLimit === null ? `${seatsUsed} seats used` : `${seatsUsed} of ${seatLimit} seats used`
  const seatLimitReached = seatLimit !== null && seatsUsed >= seatLimit

  async function handleInvite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setInviting(true)
    setInviteError(null)

    const formData = new FormData()
    formData.set('email', inviteEmail)
    formData.set('role', inviteRole)

    const result = await inviteUser(formData)

    setInviting(false)

    if (!result.invitation) {
      setInviteError(result.error ?? 'Something went wrong. Please try again.')
      return
    }

    // Round-trip the server's actual document — append a new row, or update
    // the existing one in place when this was a resend (same email already
    // had a pending invite). Only a genuinely new invite consumes a seat.
    const { invitation, created } = result
    setInvites((prev) => {
      const idx = prev.findIndex((inv) => inv.id === invitation.id)
      if (idx === -1) return [...prev, invitation]
      const next = [...prev]
      next[idx] = invitation
      return next
    })
    if (created) {
      setSeatsUsed((prev) => prev + 1)
    }
    setInviteEmail('')
  }

  function handleAskRemove(member: TeamMember) {
    setRemoveError(null)
    if (typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT) {
      setConfirmingId(member.uid)
    } else {
      setRemoveTarget(member)
    }
  }

  function cancelRemove() {
    setRemoveTarget(null)
    setConfirmingId(null)
  }

  async function confirmRemove(member: TeamMember) {
    setRemoving(true)
    setRemoveError(null)
    const result = await removeMember(member.uid)
    setRemoving(false)

    if (result.error) {
      setRemoveError(result.error)
      return
    }

    setMembers((prev) => prev.filter((m) => m.uid !== member.uid))
    setSeatsUsed((prev) => prev - 1)
    setRemoveTarget(null)
    setConfirmingId(null)
  }

  async function handleRoleChange(memberId: string, newRole: Role) {
    setRoleChanging((prev) => ({ ...prev, [memberId]: true }))
    setRoleError(null)
    const result = await updateMemberRole(memberId, newRole)
    setRoleChanging((prev) => ({ ...prev, [memberId]: false }))
    if (result.error) {
      setRoleError(result.error)
      return
    }
    setMembers((prev) => prev.map((m) => (m.uid === memberId ? { ...m, role: newRole } : m)))
  }

  async function handleResend(invite: PublicInvitation) {
    setResending((prev) => ({ ...prev, [invite.id]: true }))
    setRevokeError(null)
    const result = await resendInvitation(invite.id)
    setResending((prev) => ({ ...prev, [invite.id]: false }))
    if (result.error) {
      setRevokeError(result.error)
      return
    }
    setResent((prev) => ({ ...prev, [invite.id]: true }))
  }

  async function handleRevoke(invite: PublicInvitation) {
    setRevoking((prev) => ({ ...prev, [invite.id]: true }))
    setRevokeError(null)
    const result = await revokeInvitation(invite.id)
    setRevoking((prev) => ({ ...prev, [invite.id]: false }))
    if (result.error) {
      setRevokeError(result.error)
      return
    }
    setInvites((prev) => prev.filter((inv) => inv.id !== invite.id))
    if (isInviteActive(invite)) {
      setSeatsUsed((prev) => prev - 1)
    }
  }

  const pendingCopy = `${invites.length} invite${invites.length === 1 ? '' : 's'} waiting to be accepted`

  return (
    <div className={styles.container}>
      {/* ── Invite ────────────────────────────────────────────────────────── */}
      <form onSubmit={handleInvite} className={styles.inviteRow}>
        <span className={styles.inviteLabel}>Invite</span>
        <Input
          type="email"
          value={inviteEmail}
          onChange={(e) => {
            setInviteEmail(e.target.value)
            setInviteError(null)
          }}
          placeholder="name@company.com"
          className={styles.inviteInput}
          required
        />
        {/* Desktop: dark-fill active chip. Mobile: white/black solid — matches
            the design's mobile chip() helper, distinct from the desktop one.
            Two renders, CSS picks one (same pattern as the member rows below). */}
        <div className={`${styles.roleChips} ${styles.roleChipsDesk}`}>
          {ROLES.map((role) => (
            <Chip
              key={role}
              type="button"
              size="sm"
              active={inviteRole === role}
              onClick={() => setInviteRole(role)}
            >
              {ROLE_LABELS[role]}
            </Chip>
          ))}
        </div>
        <div className={`${styles.roleChips} ${styles.roleChipsMobile}`}>
          {ROLES.map((role) => (
            <Chip
              key={role}
              type="button"
              size="sm"
              variant="solid"
              active={inviteRole === role}
              onClick={() => setInviteRole(role)}
            >
              {ROLE_LABELS[role]}
            </Chip>
          ))}
        </div>
        <span className={styles.seatCopy}>{seatCopy}</span>
        <Button type="submit" variant="primary" size="sm" disabled={inviting || seatLimitReached}>
          {inviting ? 'SENDING…' : 'SEND INVITE'}
        </Button>
      </form>
      {inviteError && <ErrorBanner tone="danger">{inviteError}</ErrorBanner>}

      {roleError && <ErrorBanner tone="danger">{roleError}</ErrorBanner>}
      {removeError && <ErrorBanner tone="danger">{removeError}</ErrorBanner>}

      {/* ── Members ───────────────────────────────────────────────────────── */}
      {members.length === 0 ? (
        <EmptyState heading="No members yet" />
      ) : (
        <>
          {/* Desktop table */}
          <div className={styles.deskOnly}>
            <div className={styles.memberTable}>
              <div className={styles.memberHeader}>
                <span>NAME</span>
                <span>EMAIL</span>
                <span>ROLE</span>
                <span>JOINED</span>
                <span />
              </div>
              {members.map((member) => {
                const isSelf = member.uid === currentUserId
                return (
                  <div key={member.uid} className={styles.memberRow}>
                    <span className={styles.memberName}>
                      {member.name}
                      {isSelf && (
                        <Chip size="tag" tone="accent" interactive={false}>
                          You
                        </Chip>
                      )}
                    </span>
                    <span className={styles.memberEmail}>{member.email}</span>
                    {isSelf ? (
                      <Chip size="tag" interactive={false}>
                        {ROLE_LABELS[member.role]}
                      </Chip>
                    ) : (
                      <div className={styles.roleChipRow}>
                        {ROLES.map((role) => (
                          <Chip
                            key={role}
                            size="sm"
                            className={styles.roleChip}
                            active={member.role === role}
                            disabled={roleChanging[member.uid]}
                            onClick={() => handleRoleChange(member.uid, role)}
                          >
                            {ROLE_LABELS[role]}
                          </Chip>
                        ))}
                      </div>
                    )}
                    <span className={styles.memberJoined}>{formatJoined(member.joinedAt)}</span>
                    {isSelf ? (
                      <span />
                    ) : (
                      <button
                        type="button"
                        className={styles.removeBtn}
                        onClick={() => handleAskRemove(member)}
                        aria-label={`Remove ${member.name}`}
                      >
                        <Icon name="close" size={14} />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Mobile cards */}
          <div className={styles.mobileOnly}>
            <div className={styles.mobileGroup}>
              <div className={styles.groupHeading}>
                <span>MEMBERS</span>
                <span className={styles.groupRule} />
              </div>
              {members.map((member) => {
                const isSelf = member.uid === currentUserId
                const confirming = confirmingId === member.uid
                return (
                  <div
                    key={member.uid}
                    className={styles.memberCard}
                    style={{ borderLeftColor: ROLE_ACCENT[member.role] }}
                  >
                    <div className={styles.memberCardHead}>
                      <div className={styles.memberCardInfo}>
                        <div className={styles.memberCardName}>{member.name}</div>
                        <div className={styles.memberCardMeta}>
                          {member.email} · {formatJoined(member.joinedAt)}
                        </div>
                      </div>
                      {!isSelf && (
                        <button
                          type="button"
                          className={styles.removeBtn}
                          onClick={() => handleAskRemove(member)}
                          aria-label={`Remove ${member.name}`}
                        >
                          <Icon name="close" size={15} />
                        </button>
                      )}
                    </div>

                    {confirming && (
                      <div className={styles.inlineConfirm}>
                        <span className={styles.inlineConfirmText}>
                          Remove {member.name}? They will immediately lose access to bookings and equipment for
                          this workspace.
                        </span>
                        <div className={styles.inlineConfirmActions}>
                          <Button variant="secondary" size="xs" onClick={cancelRemove} disabled={removing}>
                            CANCEL
                          </Button>
                          <Button
                            variant="danger-solid"
                            size="xs"
                            onClick={() => confirmRemove(member)}
                            disabled={removing}
                          >
                            REMOVE
                          </Button>
                        </div>
                      </div>
                    )}

                    {isSelf ? (
                      <Chip size="tag" interactive={false}>
                        {ROLE_LABELS[member.role]}
                      </Chip>
                    ) : (
                      !confirming && (
                        <div className={styles.roleChipRowMobile}>
                          {ROLES.map((role) => (
                            <Chip
                              key={role}
                              size="sm"
                              variant="solid"
                              className={styles.roleChip}
                              active={member.role === role}
                              disabled={roleChanging[member.uid]}
                              onClick={() => handleRoleChange(member.uid, role)}
                            >
                              {ROLE_LABELS[role]}
                            </Chip>
                          ))}
                        </div>
                      )
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}

      {/* ── Pending invitations ───────────────────────────────────────────── */}
      {invites.length > 0 && (
        <div className={styles.pendingSection}>
          <div className={styles.groupHeading}>
            <span>PENDING INVITES</span>
            <span className={styles.pendingCopy}>{pendingCopy}</span>
            <span className={styles.groupRule} />
          </div>

          {revokeError && <ErrorBanner tone="danger">{revokeError}</ErrorBanner>}

          {invites.map((invite) => {
            const meta = inviteMeta(invite)
            const showResent = resent[invite.id]
            const displayMeta = showResent ? 'Invite re-sent just now' : meta.text
            const color = showResent ? 'var(--accent)' : pendingMetaColor(invite, meta.state)

            return (
              <div key={invite.id}>
                {/* Desktop row — wrapped, not class-combined, so deskOnly's
                    display:none isn't fighting pendingRow's display:grid at
                    equal specificity (that combo silently lost the toggle). */}
                <div className={styles.deskOnly}>
                  <div className={styles.pendingRow}>
                    <span className={styles.pendingEmail}>{invite.email}</span>
                    <Chip size="tag" interactive={false}>
                      {ROLE_LABELS[invite.role]}
                    </Chip>
                    <span className={styles.pendingMeta} style={{ color }}>
                      {displayMeta}
                    </span>
                    <div className={styles.pendingActions}>
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => handleResend(invite)}
                        disabled={resending[invite.id] || showResent}
                      >
                        {showResent ? 'SENT' : 'RESEND'}
                      </Button>
                      <Button
                        variant="danger"
                        size="xs"
                        onClick={() => handleRevoke(invite)}
                        disabled={revoking[invite.id]}
                      >
                        REVOKE
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Mobile card */}
                <div className={styles.mobileOnly}>
                  <div
                    className={styles.pendingCard}
                    style={{
                      borderLeftColor: showResent ? 'var(--accent)' : pendingAccentColor(invite, meta.state),
                    }}
                  >
                    <div className={styles.pendingCardInfo}>
                      <div className={styles.pendingCardEmail}>{invite.email}</div>
                      <div className={styles.pendingCardMeta} style={{ color }}>
                        {ROLE_LABELS[invite.role]} · {displayMeta}
                      </div>
                    </div>
                    <div className={styles.pendingActionsMobile}>
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => handleResend(invite)}
                        disabled={resending[invite.id] || showResent}
                      >
                        {showResent ? 'SENT' : 'RESEND'}
                      </Button>
                      <Button
                        variant="danger"
                        size="xs"
                        onClick={() => handleRevoke(invite)}
                        disabled={revoking[invite.id]}
                      >
                        REVOKE
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        title={`Remove ${removeTarget?.name ?? ''}?`}
        body="They will immediately lose access to bookings and equipment for this workspace. This can't be undone from here — you'll need to re-invite them."
        confirmLabel="REMOVE"
        cancelLabel="CANCEL"
        tone="danger"
        busy={removing}
        onConfirm={() => removeTarget && confirmRemove(removeTarget)}
        onCancel={cancelRemove}
      />
    </div>
  )
}
