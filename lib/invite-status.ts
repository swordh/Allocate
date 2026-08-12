/**
 * Client-safe invite status helpers — no `import 'server-only'` here.
 *
 * Deliberately separate from `lib/invite-token.ts`, which IS server-only
 * (it backs `validateInviteToken`, a security-sensitive lookup). This module
 * only turns already-fetched invitation fields into display state, so it is
 * safe for a client component (the team section's per-row status text) to
 * import directly.
 *
 * `isInviteExpired` from `lib/invite-token.ts` must NOT be imported here —
 * the expiry comparison is reimplemented below. Keep both in sync if the
 * expiry rule ever changes: missing `expiresAt` means "never expires"
 * (backward compat for invitations created before the TTL field existed).
 */

import type { Invitation } from '@/types/invitation'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** How recently `lastSentAt` must be for the UI to say "just now" rather than a relative date. */
const JUST_NOW_THRESHOLD_MS = 60 * 1000

export type InviteMetaState = 'resent' | 'expired' | 'active'

export interface InviteMeta {
  state: InviteMetaState
  text: string
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Reimplements the comparison from `lib/invite-token.ts:isInviteExpired` — see file header. */
function isExpired(expiresAt: string | undefined, now: number): boolean {
  if (!expiresAt) return false
  return Date.parse(expiresAt) < now
}

function daysAgo(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(iso)) / MS_PER_DAY))
}

/**
 * Days remaining until `expiresAt`. Moved here from `actions/invitations.ts`
 * (was a private, unexported helper) so both the server action and the
 * client-facing `inviteMeta` share one implementation.
 */
export function daysLeftFrom(expiresAt: string, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / MS_PER_DAY))
}

/**
 * Derives the team section's per-invite status line from raw invitation
 * fields. `now` is injectable for tests; defaults to `Date.now()`.
 *
 * Precedence: a very recent `lastSentAt` always wins (even over an
 * `expiresAt` that a stale `now` might otherwise read as expired, since a
 * resend always pushes `expiresAt` out — see `actions/team.ts`). Then
 * expired. Then "sent N days ago", with "· expires in N days" appended
 * when `expiresAt` is set (legacy invitations without it never expire and
 * get the bare "sent" text).
 */
export function inviteMeta(
  invite: Pick<Invitation, 'invitedAt' | 'expiresAt' | 'lastSentAt' | 'status'>,
  now: number = Date.now(),
): InviteMeta {
  const { invitedAt, expiresAt, lastSentAt } = invite

  if (lastSentAt && now - Date.parse(lastSentAt) < JUST_NOW_THRESHOLD_MS) {
    return { state: 'resent', text: 'Invite re-sent just now' }
  }

  if (isExpired(expiresAt, now)) {
    const formatted = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
      new Date(expiresAt as string),
    )
    return { state: 'expired', text: `Expired ${formatted} — resend to try again` }
  }

  const sentLabel = `Sent ${plural(daysAgo(invitedAt, now), 'day')} ago`

  if (expiresAt) {
    const left = daysLeftFrom(expiresAt, now)
    return { state: 'active', text: `${sentLabel} · expires in ${plural(left, 'day')}` }
  }

  return { state: 'active', text: sentLabel }
}
