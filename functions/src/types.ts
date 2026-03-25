import { Timestamp } from 'firebase-admin/firestore';

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
