/**
 * Client-safe invite recipient helpers — no `import 'server-only'` here.
 *
 * Same pattern as `lib/invite-status.ts`: this module only parses/classifies
 * already-typed or already-fetched values, so it's safe for a client
 * component (the team section's invite field) to import directly. The
 * server (`actions/team.ts`) re-validates everything it receives from here —
 * never trust the client's parse output.
 *
 * `EMAIL_RE` lives here as the single source of truth; it used to be a
 * private constant in `actions/team.ts`. (`actions/auth-email.ts` has its
 * own duplicate copy, out of scope to consolidate here.)
 */

export const MAX_RECIPIENTS = 25
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Trim (including surrounding U+00A0 nbsp, which Outlook pastes leave behind) and lowercase. */
export function normalizeEmail(raw: string): string {
  return raw.replace(/\u00A0/g, ' ').trim().toLowerCase()
}

export interface ParsedRecipients {
  emails: string[]
  invalid: string[]
  overflow: number
  duplicates: string[]
  /**
   * Every accepted fragment — valid or invalid — in the order it appeared in
   * the pasted text. Duplicates and over-the-cap fragments are excluded,
   * exactly matching `emails`/`invalid` (a duplicate or overflowed valid
   * address never shows up here either). Purely additive: it doesn't change
   * what counts as valid, how fragments are split, or the dedup/cap logic
   * above — it only records scan order so a UI can render invalid and valid
   * fragments interleaved (e.g. as chips) instead of as two separate lists.
   */
  fragments: RecipientFragment[]
}

export interface RecipientFragment {
  value: string
  valid: boolean
}

const SEPARATORS = new Set([',', ';', '\n', '\r', '\t'])

/**
 * Character scanner, not `String.split` — a naive split on `,`/`;` would
 * break `"Garp, Olle" <o@x.se>` (a comma inside a quoted display name) and
 * `Name <a@x.se>, Name2 <b@x.se>` style angle-bracket addresses if a display
 * name ever contained a separator inside the brackets.
 *
 * Tracks two flags: `inQuotes` (toggled by `"`, with `\`-escape support) and
 * `inAngle` (`<`...`>`). A separator only splits when both are false.
 */
function splitFragments(raw: string): string[] {
  const fragments: string[] = []
  let current = ''
  let inQuotes = false
  let inAngle = false

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]

    if (ch === '\\' && inQuotes) {
      // Escaped character inside a quoted display name — keep both chars,
      // don't let the escaped char toggle quote/angle state.
      current += ch
      if (i + 1 < raw.length) {
        current += raw[i + 1]
        i++
      }
      continue
    }

    if (ch === '"') {
      inQuotes = !inQuotes
      current += ch
      continue
    }

    if (ch === '<' && !inQuotes) {
      inAngle = true
      current += ch
      continue
    }

    if (ch === '>' && !inQuotes) {
      inAngle = false
      current += ch
      continue
    }

    if (!inQuotes && !inAngle && SEPARATORS.has(ch)) {
      fragments.push(current)
      current = ''
      continue
    }

    current += ch
  }

  fragments.push(current)
  return fragments
}

/**
 * Fragment → candidate address: if `<` is present, take the substring after
 * the LAST `<` up to the next `>` (last, so a display name that itself
 * contains `<` can't truncate the real address); otherwise the whole
 * fragment. Then strip a `mailto:` prefix and one layer of surrounding
 * quotes.
 *
 * Documented limitation: an UNQUOTED `Garp, Olle <o@x.se>` splits (at the
 * scanner stage, before this function ever sees it) into `Garp` (invalid)
 * and `Olle <o@x.se>` (valid) — Outlook quotes names like this, so treating
 * the comma as a separator here is acceptable, but the invalid half must
 * surface in `invalid`, never be silently dropped.
 */
function extractAddress(fragment: string): string {
  let candidate = fragment.trim()

  const lastAngleOpen = candidate.lastIndexOf('<')
  if (lastAngleOpen !== -1) {
    const angleClose = candidate.indexOf('>', lastAngleOpen)
    if (angleClose !== -1) {
      candidate = candidate.slice(lastAngleOpen + 1, angleClose)
    }
  }

  candidate = candidate.trim().replace(/^mailto:/i, '')
  candidate = candidate.trim().replace(/^"(.*)"$/, '$1')
  return candidate.trim()
}

/**
 * Parse a pasted blob of recipients (Outlook's `Name <email>; Name2 <email2>`
 * format, a bare comma/newline-separated list, or anything in between).
 *
 * Post-processing order: validate → deduplicate (first occurrence wins,
 * case-insensitive) → cap at `MAX_RECIPIENTS`. The cap only counts fragments
 * that already passed validation and dedup, so garbage input can't eat up
 * accepted slots. Empty fragments are dropped, which makes trailing/doubled
 * separators free.
 */
export function parseRecipients(raw: string): ParsedRecipients {
  const fragments = splitFragments(raw)
    .map((f) => f.trim())
    .filter((f) => f.length > 0)

  const emails: string[] = []
  const invalid: string[] = []
  const duplicates: string[] = []
  const fragmentsOrdered: RecipientFragment[] = []
  const seen = new Set<string>()
  let overflow = 0

  for (const fragment of fragments) {
    const normalized = normalizeEmail(extractAddress(fragment))

    if (!EMAIL_RE.test(normalized)) {
      invalid.push(fragment)
      fragmentsOrdered.push({ value: fragment, valid: false })
      continue
    }

    if (seen.has(normalized)) {
      duplicates.push(normalized)
      continue
    }

    if (emails.length >= MAX_RECIPIENTS) {
      overflow++
      continue
    }

    seen.add(normalized)
    emails.push(normalized)
    fragmentsOrdered.push({ value: normalized, valid: true })
  }

  return { emails, invalid, overflow, duplicates, fragments: fragmentsOrdered }
}

export type RecipientState = 'new' | 'member' | 'invited'

export interface ClassifiedRecipient {
  email: string
  state: RecipientState
}

/** Precedence: `member` beats `invited` beats `new` — checked in that order. */
export function classifyRecipients(
  emails: string[],
  sets: { members: Set<string>; invited: Set<string> },
): ClassifiedRecipient[] {
  return emails.map((email) => {
    if (sets.members.has(email)) return { email, state: 'member' }
    if (sets.invited.has(email)) return { email, state: 'invited' }
    return { email, state: 'new' }
  })
}

/**
 * Members + active (non-expired) pending invitations count against
 * `subscription.limits.users`. An expired-but-still-`pending` invitation
 * (nothing sweeps its status) must not permanently consume a seat, so it's
 * excluded via an in-memory `expiresAt` comparison. Missing `expiresAt`
 * means "never expires" (backward compat for invitations created before the
 * TTL field existed) — same rule as `lib/invite-status.ts`.
 *
 * Shared by the server (`actions/team.ts`'s seat guard) and the page
 * (`app/(app)/settings/team/page.tsx`'s displayed seat count) so the two
 * can't drift, which is exactly how they drifted before this module existed.
 */
export function computeSeatsUsed(
  memberCount: number,
  pendingInvites: { expiresAt?: string }[],
): number {
  const nowIso = new Date().toISOString()
  const activePendingCount = pendingInvites.filter(
    (invite) => !invite.expiresAt || invite.expiresAt >= nowIso,
  ).length
  return memberCount + activePendingCount
}

export interface SeatPreviewInput {
  emails: string[]
  members: Set<string>
  invited: Set<string>
  /** Current seats used — members + active pending invitations (see `computeSeatsUsed`), excluding this batch. */
  seatsUsed: number
  /** `subscription.limits.users`, or null if the field is missing (no limit enforced). */
  seatLimit: number | null
}

export interface SeatPreview {
  recipients: ClassifiedRecipient[]
  total: number
  newCount: number
  invitedCount: number
  memberCount: number
  seatsLeft: number | null
  overLimit: boolean
  canSubmit: boolean
  buttonLabel: string
  infoLine: string | null
  warning: string | null
}

function buildInfoLine(total: number, invitedCount: number, memberCount: number): string | null {
  if (total === 0) return null

  const clauses: string[] = []
  if (invitedCount > 0) {
    clauses.push(`${invitedCount} ${invitedCount === 1 ? 'is' : 'are'} already invited`)
  }
  if (memberCount > 0) {
    clauses.push(`${memberCount} ${memberCount === 1 ? 'is' : 'are'} already a member`)
  }

  const head = `${total} invite${total === 1 ? '' : 's'}`
  return clauses.length === 0 ? `${head}.` : `${head} · ${clauses.join(', ')}.`
}

/**
 * Everything the invite form needs to render: the classified recipient list,
 * the counts behind the copy, and whether submit is allowed.
 *
 * `canSubmit = newCount > 0 && !overLimit` — zero new addresses must block
 * submit on its own; the seat-limit check alone isn't enough (e.g. pasting
 * only already-invited addresses).
 */
export function seatPreview(input: SeatPreviewInput): SeatPreview {
  const recipients = classifyRecipients(input.emails, { members: input.members, invited: input.invited })

  const total = recipients.length
  const newCount = recipients.filter((r) => r.state === 'new').length
  const invitedCount = recipients.filter((r) => r.state === 'invited').length
  const memberCount = recipients.filter((r) => r.state === 'member').length

  const seatsLeft = input.seatLimit === null ? null : Math.max(0, input.seatLimit - input.seatsUsed)
  const overLimit = seatsLeft !== null && newCount > seatsLeft
  const canSubmit = newCount > 0 && !overLimit

  // `newCount <= 1` rather than `=== 1`: with an empty field (the state this
  // row spends most of its life in) newCount is 0, and "SEND 0 INVITES" is a
  // nonsense label for a form nobody has typed into yet. The button is
  // disabled at 0 either way — this is purely what it reads.
  const buttonLabel = newCount <= 1 ? 'SEND INVITE' : `SEND ${newCount} INVITES`
  const infoLine = buildInfoLine(total, invitedCount, memberCount)
  const warning =
    seatsLeft !== null && newCount > seatsLeft
      ? `${newCount} invites, ${seatsLeft} seats left. Remove ${newCount - seatsLeft} to send, or upgrade your plan.`
      : null

  return {
    recipients,
    total,
    newCount,
    invitedCount,
    memberCount,
    seatsLeft,
    overLimit,
    canSubmit,
    buttonLabel,
    infoLine,
    warning,
  }
}
