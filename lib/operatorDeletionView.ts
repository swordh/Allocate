/**
 * Pure, shared rendering logic for the operator deletion views (issue #252
 * step 6, PR 4 — read-only). Split out from the page/view components so it
 * can be unit tested without a Firestore emulator: everything here is a
 * plain function over already-normalised data (ISO strings, not Firestore
 * `Timestamp`s — see lib/firestore-timestamps.ts for that conversion).
 *
 * No 'server-only': the two Client Components under app/operator/customers
 * and app/operator/deletions both need these formatters for rendering, not
 * just the Server Components that query Firestore.
 */

import type {
  CompanyDeletionLedgerState,
  CompanyDeletionPhase,
} from '@/types'
import type { StripeDeletionEffect } from '@/lib/companyDeletionStripe'

// ── "Stuck" detection ───────────────────────────────────────────────────────

/**
 * Mirrors `STALE_LEASE_MS` in functions/src/company/sweep.ts. Duplicated,
 * not imported — `functions/` compiles as its own project with no path back
 * here (same reason actions/companyDeletion.ts duplicates
 * functions/src/company/format.ts's `formatDateFull`, see that file's
 * comment). Keep this in sync with the sweep's own constant by hand; a drift
 * here would only widen or narrow the "stuck" view, not break anything
 * silently, but it would make this view's central promise — "everything
 * stuck is discoverable" — quietly wrong.
 */
export const STALE_LEASE_MS = 60 * 60 * 1000 // 60 minutes

/**
 * Indirection around `Date.now()` for the view components in
 * app/operator/deletions and app/operator/customers/[companyId] — ESLint's
 * react-hooks/purity rule flags a bare `Date.now()` call inside a component
 * function body (it can't tell that a Server Component's "render" happens
 * once per request, not repeatedly like a Client Component's), but does not
 * flag it inside an ordinary named function. The staleness/urgency
 * computed here is intentionally as-of-render-time, same as every other
 * "time remaining" read in this codebase (lib/invite-status.ts,
 * lib/pendingDeletionCountdown.ts) — this is not a purity bug, just a rule
 * that can't see through JSX-returning functions.
 */
export function nowMs(): number {
  return Date.now()
}

/** Mirrors `MAX_ATTEMPTS` in functions/src/company/purge.ts — see that file
 *  for why five. Duplicated for the same reason as `STALE_LEASE_MS` above. */
export const MAX_PURGE_ATTEMPTS = 5

export interface StuckCheckInput {
  state: CompanyDeletionLedgerState
  /** ISO string, or null/undefined if the purge never started heartbeating. */
  lastHeartbeatAt?: string | null
}

/**
 * A ledger row counts as "stuck" for the operator's self-discovery view
 * when either:
 *
 * - `state === 'failed'` — the purge has exhausted its retry budget
 *   (`MAX_PURGE_ATTEMPTS`) and will NOT resume on its own. Unambiguous.
 * - `state === 'executing'` AND its heartbeat is older than the sweep's own
 *   `STALE_LEASE_MS` — the same bar the sweep itself uses to decide a lease
 *   is abandoned (functions/src/company/lease.ts `claimStaleLease`). Reusing
 *   that exact threshold, rather than inventing a shorter one for this view,
 *   avoids a false "stuck" reading on a purge that is still legitimately
 *   working through a large subtree.
 *
 * Deliberately NOT included: `state === 'requested'` past its
 * `scheduledFor`. The sweep runs every 30 minutes, so a row sitting briefly
 * past its scheduled instant is normal, not stuck — flagging it would be an
 * untrue claim about a company that is about to execute on schedule.
 */
export function isStuckDeletion(row: StuckCheckInput, nowMs: number): boolean {
  if (row.state === 'failed') return true
  if (row.state !== 'executing') return false
  if (!row.lastHeartbeatAt) return false
  const heartbeatMs = new Date(row.lastHeartbeatAt).getTime()
  if (Number.isNaN(heartbeatMs)) return false
  return nowMs - heartbeatMs > STALE_LEASE_MS
}

// ── Ledger state labels ─────────────────────────────────────────────────────

export const LEDGER_STATE_LABELS: Record<CompanyDeletionLedgerState, string> = {
  requested: 'Requested',
  executing: 'Executing',
  completed: 'Completed',
  canceled: 'Canceled',
  failed: 'Failed',
}

export const PHASE_LABELS: Record<CompanyDeletionPhase, string> = {
  stripe: 'Stripe',
  invitations: 'Invitations',
  members: 'Members',
  subtree: 'Company data',
  orphans: 'Orphaned records',
  finalize: 'Finalize',
}

/** Order the phases run in — functions/src/company/purge.ts. Used to render
 *  "how far it got" as a position, e.g. "3 of 6 phases (Members)". */
export const PHASE_ORDER: CompanyDeletionPhase[] = [
  'stripe',
  'invitations',
  'members',
  'subtree',
  'orphans',
  'finalize',
]

export function phaseProgressLabel(phase: CompanyDeletionPhase | null | undefined): string {
  if (!phase) return 'Not started'
  const index = PHASE_ORDER.indexOf(phase)
  const position = index === -1 ? '?' : String(index + 1)
  return `Phase ${position} of ${PHASE_ORDER.length} — ${PHASE_LABELS[phase]}`
}

// ── Stripe outcome labels ───────────────────────────────────────────────────

export type OutcomeTone = 'neutral' | 'accent' | 'danger'

/**
 * One label + tone per `StripeDeletionEffect` value — imported from
 * lib/companyDeletionStripe.ts (read-only reference, that module is not
 * touched by this PR) so this view can never drift from the real union.
 *
 * `resumed_unpaid` is deliberately NOT given the 'accent' (success) tone
 * that `applied` gets — see the extensive docblock on
 * `resumeSubscriptionAfterCancel` in lib/companyDeletionStripe.ts. Rendering
 * it as a plain success here would repeat exactly the mistake that field was
 * invented to prevent.
 */
export const STRIPE_EFFECT_LABELS: Record<StripeDeletionEffect, { label: string; tone: OutcomeTone }> = {
  applied: { label: 'Applied', tone: 'accent' },
  no_subscription: { label: 'No subscription to act on', tone: 'neutral' },
  already_canceled: { label: 'Subscription already canceled', tone: 'danger' },
  resumed_unpaid: { label: 'Resumed, but subscription is unpaid', tone: 'danger' },
  failed: { label: 'Stripe call failed', tone: 'danger' },
}

// ── Redacted-vs-never rendering (types/company.ts:266-288) ─────────────────

export type IdentityDisplay =
  | { kind: 'known'; text: string }
  | { kind: 'redacted' }
  | { kind: 'never' }

/**
 * `null` on a `requestedByUid/Name/Email`-shaped field means the 24-month
 * retention job redacted it; an absent field means no such event ever
 * happened (e.g. a deletion nobody ever canceled has no `canceledBy*` at
 * all). types/company.ts is explicit that this distinction exists ONLY so
 * this view can render them differently — collapsing both to "—" would
 * throw away the entire point of admitting `null` into the type. Never call
 * this with a value that was never read (i.e. never pass a field that could
 * legitimately be `undefined` for a reason OTHER than "never happened").
 */
export function identityDisplay(value: string | null | undefined): IdentityDisplay {
  if (value === null) return { kind: 'redacted' }
  if (value === undefined) return { kind: 'never' }
  return { kind: 'known', text: value }
}

// ── Time remaining ──────────────────────────────────────────────────────────

export interface TimeRemaining {
  msRemaining: number
  expired: boolean
  /** Zone-independent by construction — a duration, not an instant. See the
   *  per-company page's comment on why this, not a formatted date alone, is
   *  the primary urgency signal in this view. */
  label: string
}

/**
 * How much of the cancel window is left, as of `nowMs`. Deliberately
 * computed from raw milliseconds rather than calendar days in any
 * particular zone — a countdown is a duration, and a duration has no zone.
 * Rounds DOWN (never up) so the label never overstates how much time is
 * left: an operator deciding whether there's still time to act should never
 * be told "1 day left" when it's 23 hours and 59 minutes.
 */
export function timeRemaining(scheduledForIso: string, nowMs: number): TimeRemaining {
  const scheduledMs = new Date(scheduledForIso).getTime()
  if (Number.isNaN(scheduledMs)) {
    return { msRemaining: 0, expired: true, label: 'Unknown' }
  }
  const msRemaining = scheduledMs - nowMs
  if (msRemaining <= 0) {
    return { msRemaining: 0, expired: true, label: 'Window closed' }
  }
  const hourMs = 60 * 60 * 1000
  const dayMs = 24 * hourMs
  const days = Math.floor(msRemaining / dayMs)
  const hours = Math.floor((msRemaining % dayMs) / hourMs)
  let label: string
  if (days >= 1) {
    label = hours > 0 ? `${days}d ${hours}h left` : `${days}d left`
  } else if (hours >= 1) {
    label = `${hours}h left`
  } else {
    label = 'Less than 1h left'
  }
  return { msRemaining, expired: false, label }
}
