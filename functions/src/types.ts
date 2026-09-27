import { Timestamp } from 'firebase-admin/firestore';

// ─── Roles ───────────────────────────────────────────────────────────────────

export type UserRole = 'admin' | 'crew';

// ─── Subscription ─────────────────────────────────────────────────────────────

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'incomplete' | 'canceled';

export type Plan = 'free' | 'starter' | 'basic';

export interface PlanLimits {
  equipment: number;
  users: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { equipment: 0, users: 0 },
  starter: { equipment: 25, users: 10 },
  basic: { equipment: 100, users: 30 },
};

export interface CompanySubscription {
  status: SubscriptionStatus;
  plan: Plan;
  currentPeriodEnd: Timestamp | null;
  trialEnd: Timestamp | null;
  cancelAtPeriodEnd: boolean;
  limits: PlanLimits;
}

// ─── Custom Claims ────────────────────────────────────────────────────────────

/**
 * Shape of the Firebase Custom Claims JWT payload.
 * Must stay in sync with Security Rules and every Cloud Function auth check.
 * Canonical field name: activeCompanyId (see CRITICAL-8 in master plan).
 */
export interface CustomClaims {
  activeCompanyId: string;
  role: UserRole;
}

// ─── Firestore documents ──────────────────────────────────────────────────────

export interface UserDocument {
  name: string;
  email: string;
  activeCompanyId: string;
  createdAt: Timestamp;
}

export interface MembershipDocument {
  /** Must be stored as a field (not just the document ID) for collectionGroup GDPR queries. */
  companyId: string;
  role: UserRole;
  joinedAt: Timestamp;
}

/**
 * Mirror of `CompanyBilling` in types/company.ts — see that file for the full
 * doc comment (why it exists, who writes/clears it). Stored as ISO strings on
 * the Firestore doc, same as the root type, not `Timestamp` — written by
 * `actions/account.ts` (a Next.js server action, no `Timestamp` import) and
 * only ever read/cleared here via plain string comparisons and
 * `FieldValue.delete()`, so there was never a reason to convert.
 */
export interface CompanyBilling {
  emailMissingSince: string;
  lastReminderAt: string;
}

export interface CompanyDocument {
  name: string;
  createdAt: Timestamp;
  createdBy: string;
  stripeCustomerId: string;
  hadTrial: boolean;
  subscription: CompanySubscription;
  billing?: CompanyBilling;
}

// ─── Company deletion (issue #252, step 5) ────────────────────────────────────
//
// Mirrored from types/company.ts for the same reason `MemberCountsDelta` is
// duplicated in companyStats.ts above: functions/ compiles as its own
// project with no path alias back to the repo root, so these can't be
// imported, only kept in lockstep by hand. The canonical definitions,
// including the docblocks explaining *why* this data model looks the way it
// does (rules wildcards, GDPR basis, why the ledger is top-level), live in
// types/company.ts — read those before changing either copy.
//
// This mirror is deliberately a SUBSET of the root types. Only fields the
// Cloud Functions in PR E actually read or write are duplicated here:
//
// - `CompanyDeletionState` / `CompanyDeletionMode` / `CompanyDeletionPhase`:
//   the sweep and purge functions transition through these directly.
// - `CompanyDeletionDocument`: the ledger fields the purge/sweep/mail
//   functions touch (state, phase progress, lease/retry bookkeeping, the
//   mail template inputs, and the cancel token bookkeeping the deletion-
//   requested mail trigger writes when it mints a cancel link).
// - `CompanyDeletionCancelTokenDocument`: minted by the same mail trigger.
//
// NOT mirrored, on purpose:
// - `CompanyDeletionOperatorAction` and the ledger's cancel fields
//   (`canceledAt`, `canceledByUid/Name/Email`, `cancelSource`) — those are
//   only ever written by root-side code (`app/operator/...` and
//   `actions/companyDeletion.ts`'s `cancelCompanyDeletion*`, both PR F/step 6).
//   CORRECTION (PR G): one Cloud Function does WRITE them — the retention
//   job in company/purgeLogs.ts blanks them on schedule. It is not an
//   author: it never decides what a cancel or an operator note says, only
//   that a two-year-old one stops naming a person, and it touches them
//   through untyped `data[...]` access precisely so this mirror can stay
//   the subset it claims to be. types/company.ts carries their canonical
//   shape, including the `string | null` that redaction makes possible.
//   Giving them a home here would invite a
//   function to start writing them "for convenience" and drift from the
//   root type instead of importing this discipline the other way.
// - `identityRedactedAt`'s producer is the 24-month retention job in
//   company/purgeLogs.ts, built in PR G. It is mirrored here because
//   `runCompanyPurge` must never construct a ledger update that clobbers
//   it — and for the same reason so are `contactsRedactedAt` and
//   `formerMemberSummary`, which the same job writes on a 30/90-day clock.

export type CompanyDeletionState = 'requested' | 'executing' | 'failed';

/** Mirror of `CompanyDeletionFailureReason` in types/company.ts — read the doc comment there. */
export type CompanyDeletionFailureReason = 'attempts_exhausted' | 'no_progress' | 'operator';
/**
 * `mode` is chosen by which action triggered the deletion, never by member
 * count — see the doc comment on `CompanyDeletionMode` in types/company.ts
 * (that comment used to say "single member" and was wrong; it's the
 * canonical explanation, read it there, not here).
 */
export type CompanyDeletionMode = 'immediate' | 'window';

/**
 * Mirror of `CompanyDeletionRequestSource` in types/company.ts — read the
 * doc comment there. Mirrored (unlike the cancel-only fields the block
 * comment above this section says are deliberately NOT mirrored) because
 * `onDeletionCreated.ts`, `sweep.ts` and `purge.ts` all need it to pick the
 * right display string for `requestedByName` (see `formatRequesterDisplay`
 * in company/format.ts) when they queue mail — that decision cannot be made
 * root-side, since the mail is queued from here.
 */
export type CompanyDeletionRequestSource = 'admin' | 'operator';

export type CompanyDeletionPhase =
  | 'stripe'
  | 'invitations'
  | 'members'
  | 'subtree'
  | 'orphans'
  | 'finalize';

/** Mirror of `companies/{cid}.deletion` — see `CompanyDeletion` in types/company.ts. */
export interface CompanyDeletionMirror {
  state: CompanyDeletionState;
  requestId: string;
  requestedAt: Timestamp;
  requestedByName: string;
  scheduledFor: Timestamp;
  mode: CompanyDeletionMode;
  remindedAt?: Timestamp;
  claimedAt?: Timestamp;
  /** See `CompanyDeletionRequestSource` above. Absent = 'admin'. */
  requestSource?: CompanyDeletionRequestSource;
}

/**
 * Subset mirror of `CompanyDeletionRecord` in types/company.ts — see that
 * file for the full shape (including operator/cancel fields functions never
 * touch) and for the GDPR/Art. 17(3)(e) rationale.
 */
export interface CompanyDeletionDocument {
  requestId: string;
  companyId: string;
  companyName: string;
  mode: CompanyDeletionMode;
  state: CompanyDeletionState | 'completed' | 'canceled';

  requestedAt: Timestamp;
  /**
   * `null` = REDACTED by the 24-month retention job (purgeLogs.ts), and
   * deliberately distinguishable from an absent field. Mirrors
   * `CompanyDeletionRecord` in types/company.ts — read the doc comment
   * there, it is the canonical one.
   */
  requestedByUid: string | null;
  requestedByName: string | null;
  requestedByEmail: string | null;
  /** See `CompanyDeletionRequestSource` above. Absent = 'admin'. */
  requestSource?: CompanyDeletionRequestSource;
  scheduledFor: Timestamp;

  /** See the doc comment on this field in types/company.ts — issue #361. Absent on legacy rows; every reader falls back to 'UTC'. */
  timezone?: string;

  completedAt?: Timestamp;

  phase?: CompanyDeletionPhase;
  completedPhases?: CompanyDeletionPhase[];
  phaseCounts?: Record<string, number>;

  /** See the doc comment on this field in types/company.ts. */
  formerMemberContacts?: {
    uid: string;
    name: string;
    email: string;
    accountStatus: 'kept' | 'scheduled' | 'already_gone';
    /** Only set when accountStatus === 'scheduled' — see types/company.ts. */
    pendingDeletionScheduledFor?: Timestamp;
  }[];
  // Doubles as the "members" phase's resume marker — see types/company.ts.
  // A uid is only ever added here once cleanupOneMember reports
  // claimsUpdated: true (functions/src/company/memberCleanup.ts) — a uid
  // whose Auth claims update failed is deliberately left OUT so a later
  // resume retries her specifically, instead of leaving her claims pointed
  // at a company that no longer exists.

  /** See the doc comment on this field in types/company.ts — finalize's own per-uid resume marker. */
  finalizeMailQueuedUids?: string[];

  attempts: number;
  lastHeartbeatAt?: Timestamp;
  /** `null` = redacted (or cleared on success). See types/company.ts. */
  lastError?: string | null;

  // ─── Failure + no-progress detection (issue #331/#335) ────────────────────
  // Mirrors the block of the same name in types/company.ts — read the doc
  // comments there. `applyFailedTransition` (failDeletion.ts) is the one
  // writer of the first four; `claimStaleLease` (lease.ts) and purge.ts's
  // per-unit-of-work heartbeats are the writers of the last four.
  failureReason?: CompanyDeletionFailureReason;
  failedAt?: Timestamp;
  failedNotifiedAt?: Timestamp;
  failedNotifiedCount?: number;
  progressUnits?: number;
  leaseProgressUnits?: number;
  leaseAttempts?: number;
  noProgressResumes?: number;

  cancelTokenIds?: string[];

  purgeAfter: Timestamp;
  identityRedactedAt?: Timestamp;

  /**
   * Replaces `formerMemberContacts` once the contacts retention rule has run
   * — anonymous counts, no uids or addresses. See types/company.ts for the
   * canonical doc comment and purgeLogs.ts for the two windows.
   */
  formerMemberSummary?: {
    total: number;
    kept: number;
    scheduled: number;
    already_gone: number;
  };
  contactsRedactedAt?: Timestamp;
}

/** Mirror of `CompanyDeletionCancelToken` in types/company.ts. */
export interface CompanyDeletionCancelTokenDocument {
  requestId: string;
  companyId: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  usedAt?: Timestamp;
}

// No `PendingAccountDeletionMirror` type here — `cleanupOneMember`
// (functions/src/company/memberCleanup.ts) writes `users/{uid}.pendingDeletion`
// as an inline object literal (`{ scheduledFor, requestId }`), matching
// `PendingAccountDeletion` in types/user.ts by hand rather than through a
// named mirror type. A named-but-unused mirror was flagged as dead code in
// review — add one back here only if/when something under functions/src
// actually needs to READ this shape back (same "mirror what's called, not
// what might be" rule companyStats.ts documents for `readMemberCounts`).
