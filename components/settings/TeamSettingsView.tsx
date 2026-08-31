'use client'

import { useMemo, useRef, useState } from 'react'
import { inviteUsers, removeMember, updateMemberRole, revokeInvitation, resendInvitation } from '@/actions/team'
import { inviteMeta, daysLeftFrom } from '@/lib/invite-status'
import { parseRecipients, seatPreview, type RecipientState } from '@/lib/invite-recipients'
import Chip, { type ChipTone } from '@/components/ui/Chip'
import Input from '@/components/ui/Input'
import Button from '@/components/ui/Button'
import ErrorBanner from '@/components/ui/ErrorBanner'
import ConfirmDialog from '@/components/ui/ConfirmDialog'
import EmptyState from '@/components/ui/EmptyState'
import Icon from '@/components/ui/Icon'
import type { Role, TeamMember } from '@/types'
import type { PublicInvitation } from '@/types/invitation'
import styles from './TeamSettingsView.module.css'

/** One removable chip in the invite field — a thin wrapper around the shared
 * `Chip`, not a change to `Chip.tsx` itself. `interactive={false}` renders a
 * `<span>` (see Chip.tsx), which is what makes a nested remove `<button>`
 * valid HTML instead of a button-in-a-button. */
function RecipientChip({
  email,
  state,
  onRemove,
}: {
  email: string
  state: RecipientState
  onRemove: () => void
}) {
  // 'new' -> neutral (will actually send); 'invited' -> accent (already has a
  // pending invite, will be skipped); 'member' -> danger (already on the
  // team, will be skipped) — same precedence classifyRecipients uses.
  const tone: ChipTone = state === 'invited' ? 'accent' : state === 'member' ? 'danger' : 'neutral'

  return (
    <Chip size="tag" interactive={false} tone={tone} role="listitem" className={styles.recipientChip}>
      {email}
      <button type="button" className={styles.chipRemove} aria-label={`Remove ${email}`} onClick={onRemove}>
        <Icon name="close" size={12} />
      </button>
    </Chip>
  )
}

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

  // Committed recipient chips (validated, normalized emails) and the raw
  // text still being typed. Only committed chips count toward the preview —
  // an in-progress draft doesn't reserve a seat or count toward the button
  // label until Enter/Tab/blur/separator commits it.
  const [chips, setChips] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [inviteRole, setInviteRole] = useState<Role>('crew')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  /** Non-blocking notice: addresses skipped server-side (already invited), or
   * fragments dropped at paste-time (invalid / over the MAX_RECIPIENTS cap). */
  const [inviteNotice, setInviteNotice] = useState<string | null>(null)
  const inviteInputRef = useRef<HTMLInputElement>(null)

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

  // Classification sets for the preview — lowercase, matching how
  // `normalizeEmail` / `classifyRecipients` compare. `invites` here is the
  // live pending-invites list (state), so a chip's tone updates immediately
  // after a successful submit.
  const memberEmails = useMemo(() => new Set(members.map((m) => m.email.toLowerCase())), [members])
  const invitedEmails = useMemo(() => new Set(invites.map((inv) => inv.email.toLowerCase())), [invites])

  const preview = useMemo(
    () => seatPreview({ emails: chips, members: memberEmails, invited: invitedEmails, seatsUsed, seatLimit }),
    [chips, memberEmails, invitedEmails, seatsUsed, seatLimit],
  )

  /** Merge already-committed chips with newly typed/pasted text through a
   * single `parseRecipients` pass, so validation, case-insensitive dedup, and
   * the MAX_RECIPIENTS cap are all enforced against the *combined* set —
   * pasting 10 more addresses when 20 chips already exist must overflow at
   * 25, not treat the new batch in isolation. */
  function commitText(text: string) {
    if (!text.trim()) return
    const parsed = parseRecipients([...chips, text].join(';'))
    setChips(parsed.emails)

    const notices: string[] = []
    if (parsed.invalid.length > 0) {
      notices.push(`${parsed.invalid.length} invalid address${parsed.invalid.length === 1 ? '' : 'es'} skipped`)
    }
    if (parsed.overflow > 0) {
      notices.push(`${parsed.overflow} over the 25-address limit skipped`)
    }
    if (notices.length > 0) setInviteNotice(notices.join(' · '))
  }

  function handleDraftChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    setInviteError(null)
    const lastComma = value.lastIndexOf(',')
    const lastSemicolon = value.lastIndexOf(';')
    const lastSeparator = Math.max(lastComma, lastSemicolon)
    if (lastSeparator === -1) {
      setDraft(value)
      return
    }
    commitText(value.slice(0, lastSeparator))
    setDraft(value.slice(lastSeparator + 1))
  }

  function handleDraftPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    // Newlines don't survive a single-line <input>'s onChange (Chrome
    // collapses them to spaces, Firefox strips them) — reading the clipboard
    // directly is the only way to see a pasted newline-separated block.
    e.preventDefault()
    const text = e.clipboardData.getData('text')
    commitText(draft + text)
    setDraft('')
  }

  function handleDraftKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      // Never submit a half-typed address — commit it to a chip instead.
      e.preventDefault()
      commitText(draft)
      setDraft('')
      return
    }
    if (e.key === 'Tab') {
      commitText(draft)
      setDraft('')
      return
    }
    if (e.key === 'Backspace' && draft === '' && chips.length > 0) {
      setChips((prev) => prev.slice(0, -1))
    }
  }

  function handleDraftBlur() {
    commitText(draft)
    setDraft('')
  }

  function handleRemoveChip(email: string) {
    setChips((prev) => prev.filter((c) => c !== email))
    inviteInputRef.current?.focus()
  }

  async function handleInvite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setInviteError(null)
    setInviteNotice(null)

    // Commit any uncommitted draft first — otherwise a typed-but-not-yet-
    // separated address is silently dropped on submit.
    let currentChips = chips
    if (draft.trim()) {
      const parsed = parseRecipients([...chips, draft].join(';'))
      currentChips = parsed.emails
      setChips(currentChips)
      setDraft('')
    }

    const currentPreview = seatPreview({
      emails: currentChips,
      members: memberEmails,
      invited: invitedEmails,
      seatsUsed,
      seatLimit,
    })

    if (!currentPreview.canSubmit) {
      // Over-limit already renders via the reactive `preview.warning` banner
      // below; the only case that needs its own message here is zero new
      // addresses (nothing to warn about — canSubmit is false with `warning`
      // still null).
      if (!currentPreview.warning) {
        setInviteError('Add at least one new address to invite.')
      }
      return
    }

    setInviting(true)
    const newEmails = currentPreview.recipients.filter((r) => r.state === 'new').map((r) => r.email)
    const result = await inviteUsers(newEmails, inviteRole)
    setInviting(false)

    if (result.error) {
      setInviteError(result.error)
      return
    }

    const invitations = result.invitations ?? []

    // Round-trip the server's actual document(s) — append new rows. Every
    // returned invitation is genuinely new (there's no resend branch left),
    // so seatsUsed always grows by exactly the number returned.
    setInvites((prev) => {
      const next = [...prev]
      for (const invitation of invitations) {
        const idx = next.findIndex((inv) => inv.id === invitation.id)
        if (idx === -1) next.push(invitation)
        else next[idx] = invitation
      }
      return next
    })
    setSeatsUsed((prev) => prev + invitations.length)
    setChips([])
    setDraft('')

    const skipped = result.skipped ?? []
    if (skipped.length > 0) {
      setInviteNotice(`Already invited: ${skipped.map((s) => s.email).join(', ')} — use RESEND on their row.`)
    }
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
      <form onSubmit={handleInvite} className={styles.inviteForm}>
        <div className={styles.inviteRow}>
          <span className={styles.inviteLabel}>Invite</span>
          <Input
            ref={inviteInputRef}
            type="text"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={handleDraftChange}
            onPaste={handleDraftPaste}
            onKeyDown={handleDraftKeyDown}
            onBlur={handleDraftBlur}
            placeholder="name@company.com"
            className={styles.inviteInput}
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
                className={styles.roleChip}
                active={inviteRole === role}
                onClick={() => setInviteRole(role)}
              >
                {ROLE_LABELS[role]}
              </Chip>
            ))}
          </div>
          <span className={styles.seatCopy}>{seatCopy}</span>
          <Button type="submit" variant="primary" size="sm" disabled={inviting || !preview.canSubmit}>
            {inviting ? 'SENDING…' : preview.buttonLabel}
          </Button>
        </div>

        {chips.length > 0 && (
          <div className={styles.inviteChips} role="list">
            {preview.recipients.map((r) => (
              <RecipientChip key={r.email} email={r.email} state={r.state} onRemove={() => handleRemoveChip(r.email)} />
            ))}
          </div>
        )}

        <div className={styles.inviteInfo} aria-live="polite">
          {preview.infoLine ?? ''}
        </div>
      </form>
      {preview.warning && <ErrorBanner tone="danger">{preview.warning}</ErrorBanner>}
      {inviteNotice && <ErrorBanner tone="info">{inviteNotice}</ErrorBanner>}
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
