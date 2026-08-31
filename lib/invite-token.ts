import 'server-only'

/**
 * Shared invite-token parsing and expiry logic.
 *
 * Used by `actions/invitations.ts` (validateInviteToken), the invite accept
 * page, and — indirectly — SignupForm's live-validation call. Keeping this in
 * one file is the point: the token shape and the expiry rule must not drift
 * between the places that check them.
 *
 * `functions/src/auth/acceptInvitation.ts` cannot import from `lib/` (it's a
 * separate compilation unit). `isInviteExpired` is duplicated there — two
 * lines, with a comment pointing back at this file as the source of truth.
 */

/**
 * Loose on purpose: `[a-zA-Z0-9]{1,40}` rather than the exact `^[a-f0-9]{32}$`
 * that `randomBytes(16).toString('hex')` currently produces. Older or
 * differently-shaped tokens (past or future) keep validating structurally;
 * whether they resolve to a real invite is still gated by the Firestore
 * lookup that follows.
 */
const TOKEN_RE = /^[a-zA-Z0-9]{1,40}$/

/**
 * Extracts a raw invite token from arbitrary user input: a full invite URL
 * (`/invite/<token>` or `?token=<token>`), or a bare token pasted directly.
 *
 * Returns null if the input doesn't parse to anything matching the token
 * shape — callers should treat that as `reason: 'malformed'`.
 */
export function parseInviteToken(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  let candidate = trimmed

  try {
    const url = new URL(trimmed)
    const pathMatch = url.pathname.match(/^\/invite\/([a-zA-Z0-9]{1,40})$/)
    if (pathMatch) {
      candidate = pathMatch[1]
    } else {
      const fromQuery = url.searchParams.get('token')
      candidate = fromQuery ?? trimmed
    }
  } catch {
    // Not a URL — treat the whole trimmed string as the token.
    candidate = trimmed
  }

  return TOKEN_RE.test(candidate) ? candidate : null
}

/**
 * Canonical expiry rule: a missing `expiresAt` means the invitation never
 * expires. This is the backward-compatibility mechanism for every invitation
 * created before the TTL field existed — do not derive expiry from
 * `invitedAt` instead, which would retroactively kill them all at once.
 *
 * Duplicated (two lines) in functions/src/auth/acceptInvitation.ts, which
 * cannot import from lib/. Keep both in sync if this rule ever changes.
 */
export function isInviteExpired(expiresAt?: string): boolean {
  if (!expiresAt) return false
  return Date.parse(expiresAt) < Date.now()
}
