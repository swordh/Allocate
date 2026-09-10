import { Timestamp } from 'firebase-admin/firestore';

// ─── Roles ───────────────────────────────────────────────────────────────────

export type UserRole = 'admin' | 'crew' | 'viewer';

// ─── Subscription ─────────────────────────────────────────────────────────────

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'incomplete' | 'canceled';

export type Plan = 'free' | 'starter' | 'basic';

export interface PlanLimits {
  equipment: number;
  users: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { equipment: 0, users: 0 },
  starter: { equipment: 25, users: 10 },
  basic: { equipment: 100, users: 30 },
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
