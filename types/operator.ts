export type FeedbackType = 'feature_request' | 'bug_report' | 'support'
export type FeedbackStatus = 'open' | 'in_progress' | 'done' | 'wont_fix'
export type FeedbackPriority = 'low' | 'medium' | 'high'

export interface FeedbackNote {
  id: string
  text: string
  createdAt: string   // ISO string
  createdBy: string   // operator email
}

export interface OperatorFeedback {
  id: string
  type: FeedbackType
  title: string
  description: string
  submittedAt: string        // ISO string
  submittedBy: string        // uid
  userEmail: string
  companyId: string
  companyName: string
  userName: string
  status: FeedbackStatus
  priority: FeedbackPriority
}

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
