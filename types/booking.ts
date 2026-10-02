// Status machine:
//   pending    → waiting for approval (requiresApproval bookings only)
//   confirmed  → approved / no approval needed; equipment reserved but not yet collected
//   checked_out → equipment physically handed over (manually, or automatically at
//                 the start time when the company has auto check-out on — #329)
//   returned   → equipment back; booking closed (manually, or automatically at the
//                 end time when the company has auto check-in on — #329)
//   cancelled  → terminal state; equipment released
// Note: there is no 'ready' status — 'confirmed' is the canonical pre-checkout state.
export type BookingStatus = 'pending' | 'confirmed' | 'checked_out' | 'returned' | 'cancelled'
// Who performed a check-out / check-in. Deliberately no user id — traceability is
// "a person did it" vs "the automation did", nothing more (#329).
export type BookingStatusSource = 'manual' | 'auto'
export type ApprovalStatus = 'none' | 'pending' | 'approved' | 'rejected'

// One entry per equipment item included in the booking.
// quantity is always 1 for unit-tracked items.
export interface BookingItem {
  equipmentId: string
  quantity: number
  unitId?: string   // set for unit-tracked items; identifies the specific physical unit
}

export interface Booking {
  id: string
  projectName: string
  notes: string
  items: BookingItem[]
  equipmentIds: string[]         // denormalized for query indexing; derived from items
  unitIds?: string[]             // denormalized; all unitId values from unit-tracked items
  startDate: string              // "YYYY-MM-DD" — inclusive
  endDate: string                // "YYYY-MM-DD" — inclusive
  startTime?: string | null      // "HH:MM" — null/absent means all-day
  endTime?: string | null        // "HH:MM" — null/absent means all-day
  userId: string | null          // null if user was deleted (GDPR anonymized)
  userName: string | null        // null — not stored (userId is the reference; resolve name at read time if needed)
  status: BookingStatus
  createdAt: string              // ISO string (converted from Timestamp at render boundary)
  updatedAt?: string             // ISO string; set on every write after creation
  requiresApproval: boolean
  approverId: string | null      // userId of designated approver; falls back to any Admin if null
  approvalStatus: ApprovalStatus
  rejectionReason: string | null // set when approvalStatus === 'rejected'
  cancelledAt: string | null     // ISO string; set when status === 'cancelled'
  cancelledBy: string | null     // userId who cancelled
  checkedOutAt?: string | null   // ISO string; set when the booking was checked out (absent on older bookings)
  checkOutSource?: BookingStatusSource  // how it was checked out
  returnedAt?: string | null     // ISO string; set when the booking was checked in (absent on older bookings)
  returnSource?: BookingStatusSource    // how it was checked in
}
