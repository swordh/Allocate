export type BookingStatus = 'pending' | 'confirmed' | 'checked_out' | 'returned' | 'cancelled'
export type ApprovalStatus = 'none' | 'pending' | 'approved' | 'rejected'

// One entry per equipment item included in the booking.
// quantity is always 1 for individual-tracked items.
export interface BookingItem {
  equipmentId: string
  quantity: number
}

export interface Booking {
  id: string
  projectName: string
  notes: string
  items: BookingItem[]
  equipmentIds: string[]         // denormalized for query indexing; derived from items
  startDate: string              // "YYYY-MM-DD" — inclusive
  endDate: string                // "YYYY-MM-DD" — inclusive
  userId: string | null          // null if user was deleted (GDPR anonymized)
  userName: string               // denormalized at creation time; not updated if user renames
  status: BookingStatus
  createdAt: string              // ISO string (converted from Timestamp at render boundary)
  updatedAt?: string             // ISO string; set on every write after creation
  requiresApproval: boolean
  approverId: string | null      // userId of designated approver; falls back to any Admin if null
  approvalStatus: ApprovalStatus
  rejectionReason: string | null // set when approvalStatus === 'rejected'
  cancelledAt: string | null     // ISO string; set when status === 'cancelled'
  cancelledBy: string | null     // userId who cancelled
}
