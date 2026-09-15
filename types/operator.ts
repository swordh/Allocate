// Settable unions — exactly the real values a caller may write. Kept narrow
// on purpose: actions/submitFeedback.ts's `type: FeedbackType` parameter and
// the setter-button arrays in FeedbackListView.tsx/FeedbackDetailView.tsx
// both rely on this NOT including 'unknown', so nothing on the write path
// can ever produce it.
export type FeedbackType = 'feature_request' | 'bug_report' | 'support'
export type FeedbackStatus = 'open' | 'in_progress' | 'done' | 'wont_fix'
export type FeedbackPriority = 'low' | 'medium' | 'high'

// Stored/read-side counterparts — what a document actually holds once you
// admit it might be corrupt or pre-migration. 'unknown' is deliberately NOT
// folded into the settable unions above: it is a fallback for a document
// missing the field (see the `?? 'unknown'` reads in
// app/operator/feedback/page.tsx and [id]/page.tsx), never a value a caller
// can supply. Use these — not the settable unions — for anything read out of
// Firestore: OperatorFeedback's fields, the label maps, row/thread-entry
// types passed into the view components.
export type StoredFeedbackType = FeedbackType | 'unknown'
export type StoredFeedbackStatus = FeedbackStatus | 'unknown'
export type StoredFeedbackPriority = FeedbackPriority | 'unknown'

export const FEEDBACK_TYPES: FeedbackType[] = ['feature_request', 'bug_report', 'support']
export const FEEDBACK_STATUSES: FeedbackStatus[] = ['open', 'in_progress', 'done', 'wont_fix']
export const FEEDBACK_PRIORITIES: FeedbackPriority[] = ['low', 'medium', 'high']

// Design's uppercase labels (23/24 Operator - Feedback). `wont_fix` reads as
// "NO ACTION" in the design, not "Won't fix" — this is the one source of
// truth for that label, used by both the setter buttons and the event text
// contract ("Status changed {from} → {to}"). `unknown` is not part of the
// design — it renders literally as "UNKNOWN" so a corrupt document is
// unmistakable rather than blending in as a plausible ticket. Keyed by the
// Stored* types (not the settable ones) since these maps are used for
// rendering whatever a document actually holds.
export const FEEDBACK_STATUS_LABELS: Record<StoredFeedbackStatus, string> = {
  open: 'OPEN',
  in_progress: 'IN PROGRESS',
  done: 'DONE',
  wont_fix: 'NO ACTION',
  unknown: 'UNKNOWN',
}

export const FEEDBACK_PRIORITY_LABELS: Record<StoredFeedbackPriority, string> = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  unknown: 'UNKNOWN',
}

export const FEEDBACK_TYPE_LABELS: Record<StoredFeedbackType, string> = {
  bug_report: 'BUG',
  feature_request: 'FEATURE',
  support: 'SUPPORT',
  unknown: 'UNKNOWN',
}

export const FEEDBACK_STATUS_FILTERS = ['all', ...FEEDBACK_STATUSES] as const
export type FeedbackStatusFilter = (typeof FEEDBACK_STATUS_FILTERS)[number]

export const FEEDBACK_TYPE_FILTERS = ['all', 'feature_request', 'bug_report', 'support'] as const
export type FeedbackTypeFilter = (typeof FEEDBACK_TYPE_FILTERS)[number]

export const FEEDBACK_SORTS = ['newest', 'priority', 'company'] as const
export type FeedbackSort = (typeof FEEDBACK_SORTS)[number]

export const FEEDBACK_SORT_LABELS: Record<FeedbackSort, string> = {
  newest: 'Newest first',
  priority: 'Priority',
  company: 'Company',
}

export interface OperatorFeedback {
  id: string
  // Stored* types: this is a document as read back from Firestore, which
  // may be corrupt or predate the field — never the settable unions used to
  // write one.
  type: StoredFeedbackType
  title: string
  description: string
  submittedAt: string        // ISO string
  submittedBy: string        // uid
  userEmail: string
  companyId: string
  companyName: string
  userName: string
  status: StoredFeedbackStatus
  priority: StoredFeedbackPriority
}

/**
 * The timeline (screen 24) mixes three kinds of entry: the feedback report
 * itself, operator notes, and status/priority-change events. Only `note` and
 * `event` are persisted — both in the SAME subcollection
 * (`operatorFeedback/{id}/notes`), discriminated by `kind`. One collection
 * means one query and one sort key (`createdAt`); it also means the status
 * change and its event are written in the same batch, so there is no
 * half-written timeline. The `report` entry is never stored — it is
 * synthesized from the OperatorFeedback document itself wherever the thread
 * is rendered.
 *
 * Existing documents predate `kind` entirely and must be read as an
 * EXPLICIT `?? 'note'` fallback (never a falsy check) at every read site —
 * see app/operator/feedback/page.tsx and app/operator/feedback/[id]/page.tsx.
 * A falsy check would silently swallow a future third kind into "note"
 * instead of surfacing it as a bug.
 */
export interface FeedbackNote {
  id: string
  kind: 'note'
  text: string
  createdAt: string   // ISO string
  createdBy: string   // operator email
}

export interface FeedbackEvent {
  id: string
  kind: 'event'
  /** Pre-rendered text — the contract is "Status changed {FROM} → {TO}" /
   *  "Priority changed {FROM} → {TO}", using FEEDBACK_STATUS_LABELS /
   *  FEEDBACK_PRIORITY_LABELS. Written once by the server action, never
   *  reconstructed client-side. */
  text: string
  createdAt: string   // ISO string
  createdBy: string   // operator email
}

export type FeedbackTimelineEntry = FeedbackNote | FeedbackEvent

export const SEGMENTS = [
  'all',
  'active',
  'trialing',
  'past_due',
  'canceled',
  'trial_ending',
  'no_bookings_30d',
] as const

export type Segment = (typeof SEGMENTS)[number]

export const SEGMENT_LABELS: Record<Segment, string> = {
  all: 'All customers',
  active: 'Active',
  trialing: 'Trialing',
  past_due: 'Past due',
  canceled: 'Canceled',
  trial_ending: 'Trial ends in 7 d',
  no_bookings_30d: 'No bookings 30 d',
}

export interface CompanyRow {
  id: string
  name: string
  createdAt: string          // ISO string
  stripeCustomerId: string
  subscriptionStatus: string
  subscriptionPlan: string
  currentPeriodEnd: string   // ISO string
  trialEnd: string | null    // ISO string
  cancelAtPeriodEnd: boolean
  hadTrial: boolean
  /**
   * Denormalized from companies/{id}.stats. Null on companies that predate the
   * mirror and have not been backfilled — render those as unknown rather than
   * zero, because zero is a claim and null is an admission.
   */
  equipmentCount: number | null
  bookingsCreated: number | null
  bookingsCancelled: number | null
  lastBookingAt: string | null   // ISO string
  memberCount: number | null
  hasStats: boolean
  /**
   * From `subscription.limits`. NOT guaranteed present, despite being set at
   * company creation — actions/team.ts's seat guard and
   * lib/invite-recipients.ts's `seatLimit` both handle
   * `subscription.limits.users` being undefined, so this list has to treat
   * a missing cap the same way it treats a missing `stats` field: render it
   * as unknown, never as a fabricated 0.
   */
  limits: { equipment: number | null; users: number | null }
}

export const SORTS = ['last_booking', 'name', 'signed_up', 'members'] as const
export type Sort = (typeof SORTS)[number]

export const SORT_LABELS: Record<Sort, string> = {
  last_booking: 'Last booking',
  name: 'Company A–Z',
  signed_up: 'Signed up',
  members: 'Members',
}

export const PLANS = ['starter', 'basic'] as const
export type PlanFilter = (typeof PLANS)[number]

export const PLAN_FILTER_LABELS: Record<PlanFilter, string> = {
  starter: 'Starter',
  basic: 'Basic',
}

// ─── Company deletion — operator views (issue #252 step 6, PR 4) ──────────
//
// Read-only shapes for the two site-wide deletion list entries and the
// per-company history. Sourced from `companyDeletions/{requestId}` — the
// ledger, never `companies/{cid}.deletion` — per the plan's "läs ledgern,
// inte spegeln": the mirror on the company document can never carry
// `'failed'` (see types/company.ts's `CompanyDeletionState` docblock) and
// does not survive a completed purge, so a view built on it would be blind
// to exactly the two things this screen exists to surface.

/**
 * One row of `companyDeletions/{requestId}`, projected down to what the
 * list and detail views render. Every timestamp is already an ISO string —
 * conversion from Firestore `Timestamp` happens once, in the server page,
 * via lib/firestore-timestamps.ts.
 *
 * The identity fields keep the `null` (redacted) vs `undefined` (never
 * happened) distinction from `CompanyDeletionRecord` verbatim — see
 * lib/operatorDeletionView.ts's `identityDisplay`. Do not default either to
 * `''` or `'—'` anywhere upstream of that function; that is precisely the
 * collapse the design brief forbids.
 */
export interface CompanyDeletionRow {
  requestId: string
  companyId: string
  /** Snapshot at request time — may be the only surviving name once the
   *  company document itself is gone. */
  companyName: string
  mode: 'immediate' | 'window'
  state: 'requested' | 'executing' | 'completed' | 'canceled' | 'failed'

  requestedAt: string                 // ISO string
  requestedByUid: string | null | undefined
  requestedByName: string | null | undefined
  requestedByEmail: string | null | undefined
  scheduledFor: string                // ISO string

  canceledAt?: string                 // ISO string
  canceledByUid?: string | null
  canceledByName?: string | null
  canceledByEmail?: string | null
  cancelSource?: 'admin_ui' | 'cancel_link' | 'operator'

  completedAt?: string                // ISO string

  stripePause?: { at: string; effect: string; error?: string }
  stripeResume?: { at: string; effect: string; error?: string }

  operatorActions?: {
    action: string
    // `string` = known, `null` = redacted (24-month retention job), `undefined`
    // = this entry never carried an actor (a malformed/legacy doc — every
    // writer in actions/operatorCompanyDeletion.ts is required to set both
    // explicitly). Widened from `string | null` once
    // lib/operatorDeletionQueries.ts stopped coalescing an omitted field to
    // `null` — see that file's `mapDeletionDoc` for why the coalescing had to
    // go, and identityDisplay (lib/operatorDeletionView.ts) for how the three
    // states render differently.
    byUid: string | null | undefined
    byName: string | null | undefined
    at: string
    note?: string
  }[]

  phase?: 'stripe' | 'invitations' | 'members' | 'subtree' | 'orphans' | 'finalize'
  completedPhases?: string[]
  phaseCounts?: Record<string, number>

  attempts: number
  lastHeartbeatAt?: string            // ISO string
  lastError?: string | null
}

export const DELETION_SEGMENTS = ['active', 'stuck', 'all'] as const
export type DeletionSegment = (typeof DELETION_SEGMENTS)[number]

export const DELETION_SEGMENT_LABELS: Record<DeletionSegment, string> = {
  // The support entry point: "someone got in touch, something's wrong" —
  // start from everything currently in flight.
  active: 'In progress',
  // The self-discovery entry point: nobody has to report this for it to be
  // findable. See lib/operatorDeletionView.ts's `isStuckDeletion`.
  stuck: 'Stuck or failed',
  all: 'All history',
}
