export type BookingStatus = 'ready' | 'checked_out' | 'pending' | 'returned' | 'needs_repair'
export type ApprovalStatus = 'none' | 'pending' | 'approved' | 'rejected'

// One entry per equipment type included in the booking.
// quantity is always 1 for individual-tracked items.
export interface BookingItem {
  equipmentId: string
  quantity: number
}

export interface Booking {
  id: string
  projectName: string
  items: BookingItem[]
  startTime: string           // ISO string
  endTime: string             // ISO string
  userId: string | null       // null if user was deleted (anonymized)
  status: BookingStatus
  createdAt: string           // ISO string
  requiresApproval: boolean
  approverId: string | null   // userId of approver
  approvalStatus: ApprovalStatus
}
