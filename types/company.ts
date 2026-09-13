export interface CompanyPreferences {
  bookingTimeSlotMinutes: number
  autoCheckout: boolean
  autoCheckin: boolean
  timezone: string
}

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'incomplete' | 'canceled'
export type Plan = 'starter' | 'basic'
export type BillingInterval = 'month' | 'year'

export interface Subscription {
  status: SubscriptionStatus
  plan: Plan
  stripeSubscriptionId?: string
  currentPeriodEnd: string        // ISO string
  limits: { equipment: number; users: number }
  trialEnd?: string               // ISO string
  cancelAtPeriodEnd?: boolean
  interval?: BillingInterval
}

/**
 * Derived counters mirrored onto the company document so the operator customer
 * list can filter and sort without querying each company's subcollections.
 * Absent on companies created before the mirror existed — read defensively until
 * tools/backfill_company_stats.js has run everywhere.
 */
export interface CompanyStats {
  equipmentCount: number          // active equipment only
  bookingsCreated: number         // lifetime, never decremented
  bookingsCancelled: number       // lifetime, never decremented
  lastBookingAt: string | null    // ISO string
  memberCount: number             // companies/{id}/members subcollection size
  updatedAt: string               // ISO string
}

// ─── Company deletion (issue #252, step 5) ────────────────────────────────────
//
// This block lays the data model only. No action, Cloud Function, or Stripe
// code reads or writes any of this yet — PR D-G build the behaviour on top of
// this shape. Nothing here changes how the product behaves today.

/**
 * `requested` — a deletion is scheduled (`mode: 'window'`) or about to execute
 *   (`mode: 'immediate'`, briefly, before the sweep's lease flips it).
 * `executing` — the sweep has claimed the purge (see `claimedAt`) and is
 *   working through it.
 * `failed` — the purge has exhausted its retry budget (five attempts, per the
 *   plan) and needs operator attention. This is the state step 6's "stuck"
 *   view hangs off of.
 *
 * There is no `completed` value: a successfully executed deletion is
 * represented by the company document no longer existing, not by a terminal
 * state written onto it. A cancelled deletion is represented by this whole
 * `deletion` field being removed from the company document, not by a
 * cancelled state — so absence of the field is the only "nothing is going on"
 * signal callers need to check.
 */
export type CompanyDeletionState = 'requested' | 'executing' | 'failed'

/**
 * `immediate` — the company has a single member; there is no one else for a
 * window to protect, so the purge starts right away.
 * `window` — every other company; a seven-day window during which any admin
 * can cancel.
 */
export type CompanyDeletionMode = 'immediate' | 'window'

/**
 * Member-visible deletion status, mirrored onto `companies/{cid}.deletion`.
 *
 * Why this lives on the company document rather than only on the
 * `companyDeletions` ledger below: `firestore.rules:24` already makes the
 * company document readable by every member with a matching
 * `activeCompanyId`, and the product brief requires that *all* members (not
 * just admins) can see the scheduled end date — the in-product banner is a
 * crew member's only warning that their account will be deleted along with
 * the company. Putting the field here reuses a read path that already
 * exists instead of inventing a new member-readable surface.
 *
 * Absence of this field means no deletion is in progress.
 *
 * IMPORTANT — do not add anything sensitive to this object. It inherits
 * whatever visibility `companies/{cid}` has, and separately,
 * `firestore.rules:84` (`match /companies/{companyId}/{document=**}`) makes
 * *any* subcollection nested under a company readable by every member,
 * crew included, unless it gets its own narrower rule first. That wildcard is
 * exactly why the audit trail and the cancel tokens below are modeled as
 * top-level collections instead of company subcollections — do not "simplify"
 * this later by moving them under `companies/{cid}`.
 */
export interface CompanyDeletion {
  state: CompanyDeletionState
  requestId: string
  requestedAt: string              // ISO string
  requestedByName: string
  scheduledFor: string             // ISO string — same as `deleteAt` on the ledger
  mode: CompanyDeletionMode
  /** Set once the single reminder mail has gone out; absent otherwise. */
  remindedAt?: string              // ISO string
  /** Set when the sweep's lease transaction claims the purge (state -> 'executing'). */
  claimedAt?: string               // ISO string
}

export interface Company {
  id: string
  name: string
  createdAt: string               // ISO string
  createdBy: string
  stripeCustomerId: string
  subscription: Subscription
  preferences?: CompanyPreferences
  stats?: CompanyStats
  deletion?: CompanyDeletion
}

// ─── Company deletion ledger (companyDeletions/{requestId}) ──────────────────

/**
 * Ledger state. Broader than `CompanyDeletion['state']` above because the
 * ledger is the permanent record — it must still show "cancelled" or
 * "completed" after the field on the company document (or the company
 * document itself) is long gone.
 */
export type CompanyDeletionLedgerState =
  | 'requested'
  | 'executing'
  | 'completed'
  | 'canceled'
  | 'failed'

/**
 * Purge phases, run in this exact order (see the plan). Recorded so a purge
 * that dies mid-phase can resume from `phase` rather than restart fase 1.
 */
export type CompanyDeletionPhase =
  | 'stripe'
  | 'invitations'
  | 'members'
  | 'subtree'
  | 'orphans'
  | 'finalize'

export type CompanyDeletionCancelSource = 'admin_ui' | 'cancel_link'

/**
 * One entry per operator intervention on this deletion (steg 6, not built
 * yet). Written only from `app/operator/...` server actions — the purge
 * itself never appends here, it only reads/writes the phase/progress and
 * lease fields below.
 */
export interface CompanyDeletionOperatorAction {
  action: string
  byUid: string
  byName: string
  at: string                       // ISO string
  note?: string
}

/**
 * `companyDeletions/{requestId}` — top-level, no Firestore rule (default
 * deny; see the comment block in `firestore.rules` next to the
 * `operatorNotes`/`companyEvents` one). Not a subcollection under
 * `companies/{cid}` for two reasons:
 *
 * 1. It must survive the company document being deleted in the purge's final
 *    phase — that's the entire point of this ledger existing: step 6's
 *    operator view needs to show a completed deletion's history after the
 *    company itself is gone.
 * 2. It carries operator notes (`operatorActions`) and internal lease/retry
 *    data (`attempts`, `lastHeartbeatAt`, `cancelTokenIds`) that must never be
 *    member-readable. A subcollection under `companies/{cid}` would inherit
 *    read access from the `companies/{companyId}/{document=**}` wildcard at
 *    `firestore.rules:84` — putting it there would hand every member,
 *    including crew, an operator's internal notes about their own company's
 *    deletion.
 *
 * GDPR: `identityRedactedAt` is when the 24-month retention job (PR G) blanks
 * out `requestedByUid`/`requestedByName`/`requestedByEmail` and the cancel
 * equivalents while leaving the rest of the row intact — the event stays
 * visible in the operator history, the person behind it doesn't. Legal basis
 * is GDPR Art. 17(3)(e) (processing necessary for the establishment, exercise
 * or defence of legal claims — an accountability trail for who requested a
 * company's deletion). **That interpretation has not yet been confirmed by
 * counsel.** The decision to build it this way is made; the confirmation is
 * outstanding. Do not treat this comment as that confirmation.
 *
 * NEVER add this collection to `deleteAccount`'s anonymisation loop. The
 * entire purpose of `requestedByName`/`requestedByEmail`/`requestedByUid` is
 * to survive the requester deleting their own account later — that's what
 * makes it an audit trail. `identityRedactedAt` above is the only sanctioned
 * way this data ever gets scrubbed, and it runs on its own 24-month schedule,
 * not on account deletion.
 */
export interface CompanyDeletionRecord {
  requestId: string
  companyId: string
  /** Snapshot at request time — the company name may not survive to be read later. */
  companyName: string
  mode: CompanyDeletionMode
  state: CompanyDeletionLedgerState

  requestedAt: string              // ISO string
  requestedByUid: string
  requestedByName: string
  requestedByEmail: string
  scheduledFor: string             // ISO string ("deleteAt")

  canceledAt?: string              // ISO string
  canceledByUid?: string
  canceledByName?: string
  canceledByEmail?: string
  cancelSource?: CompanyDeletionCancelSource

  completedAt?: string             // ISO string

  operatorActions?: CompanyDeletionOperatorAction[]

  /** Current phase and the ones already finished — the resume point after a crash. */
  phase?: CompanyDeletionPhase
  completedPhases?: CompanyDeletionPhase[]
  /** Free-form per-phase counters (e.g. subtree collections purged so far). Shape owned by PR E. */
  phaseCounts?: Record<string, number>

  /** Purge attempts so far; `failed` is set once this hits five (see the plan). */
  attempts: number
  /** Written roughly every 15s while a purge is running; the sweep's stuck-lease signal. */
  lastHeartbeatAt?: string         // ISO string
  lastError?: string

  /** Cancel tokens issued for this request, so they can be invalidated together on cancel/completion. */
  cancelTokenIds?: string[]

  /** When this ledger row itself becomes eligible for deletion (PR G retention job). */
  purgeAfter: string               // ISO string
  /** Set by the 24-month retention job; see the GDPR note above. */
  identityRedactedAt?: string      // ISO string
}

// ─── Company deletion cancel tokens (companyDeletionCancelTokens/{token}) ─────

/**
 * `companyDeletionCancelTokens/{token}` — top-level, no Firestore rule
 * (default deny; see `firestore.rules`). Deliberately not a subcollection
 * under `companies/{cid}`: the wildcard at `firestore.rules:84` would make
 * every token readable by any member with a matching `activeCompanyId`,
 * which would let a crew member — who was never sent the mail — read an
 * admin's cancel token and cancel a deletion they have no authority over.
 * The token's whole job is to be a bearer secret mailed only to admins.
 *
 * The document ID is the token itself — a single `get` by ID, never a
 * `list`, so nothing about tokens is enumerable even if a rule existed.
 */
export interface CompanyDeletionCancelToken {
  requestId: string
  companyId: string
  createdAt: string                // ISO string
  expiresAt: string                // ISO string
  usedAt?: string                  // ISO string — set on first (and only) use
}
