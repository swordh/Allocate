export type BookingStatus = 'ready' | 'checked_out' | 'pending' | 'returned' | 'needs_repair'
export type ApprovalStatus = 'none' | 'pending' | 'approved' | 'rejected'

export interface Booking {
  id: string
  projectName: string
  equipmentIds: string[]
  startTime: string           // ISO string
  endTime: string             // ISO string
  userId: string | null       // null if user was deleted (anonymized)
  status: BookingStatus
  createdAt: string           // ISO string
  requiresApproval: boolean
  approverId: string | null   // userId of approver
  approvalStatus: ApprovalStatus
}
