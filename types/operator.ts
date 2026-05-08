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
