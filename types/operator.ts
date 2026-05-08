export type FeedbackType = 'feature_request' | 'bug_report' | 'support'
export type FeedbackStatus = 'open' | 'in_progress' | 'done' | 'wont_fix'
export type FeedbackPriority = 'low' | 'medium' | 'high'

export interface OperatorFeedback {
  id: string
  type: FeedbackType
  title: string
  description: string
  submittedAt: string        // ISO string
  submittedBy: string        // uid
  companyId: string
  companyName: string
  userName: string
  status: FeedbackStatus
  priority: FeedbackPriority
}

export interface CompanyRow {
  id: string
  name: string
  createdAt: string          // ISO string
  stripeCustomerId: string
  subscriptionStatus: string
  subscriptionPlan: string
  currentPeriodEnd: string   // ISO string
  cancelAtPeriodEnd: boolean
  hadTrial: boolean
  memberCount: number
}
