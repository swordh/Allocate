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
}
