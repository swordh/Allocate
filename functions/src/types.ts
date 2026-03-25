import { Timestamp, FieldValue } from 'firebase-admin/firestore';

// ─── Roles ───────────────────────────────────────────────────────────────────

export type UserRole = 'admin' | 'crew' | 'viewer';

// ─── Subscription ─────────────────────────────────────────────────────────────

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';

export type Plan = 'basic' | 'small' | 'mid' | 'large' | 'enterprise';

export interface PlanLimits {
  equipment: number;
  users: number;
}

/**
 * Plan limits keyed by plan name.
 * Enterprise limits are set manually per customer — these are placeholder values
 * that should never be used programmatically for enforcement.
 */
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  basic:      { equipment: 10,  users: 3  },
  small:      { equipment: 25,  users: 10 },
  mid:        { equipment: 60,  users: 25 },
  large:      { equipment: 150, users: 75 },
  enterprise: { equipment: 9999, users: 9999 }, // provisioned manually
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

export interface CompanyDocument {
  name: string;
  createdAt: Timestamp;
  createdBy: string;
  stripeCustomerId: string;
  hadTrial: boolean;
  subscription: CompanySubscription;
}

// ─── Booking documents ────────────────────────────────────────────────────────

export type BookingStatus = 'pending' | 'confirmed' | 'checked_out' | 'returned' | 'cancelled';
export type ApprovalStatus = 'none' | 'pending' | 'approved' | 'rejected';

export interface BookingItem {
  equipmentId: string;
  quantity: number;
}

/**
 * Firestore representation of a booking document.
 * Timestamps are stored as Firestore Timestamp objects server-side;
 * the client types in types/booking.ts use ISO strings after conversion.
 */
export interface BookingDocument {
  projectName: string;
  notes: string;
  items: BookingItem[];
  equipmentIds: string[];          // denormalized flat array for array-contains queries
  startDate: string;               // "YYYY-MM-DD"
  endDate: string;                 // "YYYY-MM-DD"
  userId: string | null;
  userName: string;
  status: BookingStatus;
  createdAt: Timestamp | FieldValue;
  updatedAt: Timestamp | FieldValue | null;
  requiresApproval: boolean;
  approverId: string | null;
  approvalStatus: ApprovalStatus;
  rejectionReason: string | null;
  cancelledAt: Timestamp | null;
  cancelledBy: string | null;
}

// ─── Equipment documents ───────────────────────────────────────────────────────

export type TrackingType = 'individual' | 'quantity';

export interface EquipmentDocument {
  name: string;
  category: string;
  trackingType: TrackingType;
  totalQuantity: number;
  serialNumber: string | null;
  active: boolean;
  status: string;
  requiresApproval: boolean;
  approverId: string | null;
  createdAt: Timestamp;
  createdBy: string;
}
