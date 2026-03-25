export type Role = 'admin' | 'crew' | 'viewer'

export interface UserProfile {
  id: string
  name: string
  email: string
  activeCompanyId: string
}

export interface Membership {
  companyId: string        // field, not just document ID
  role: Role
  joinedAt: string         // ISO string
}

export interface TeamMember extends UserProfile {
  role: Role
  joinedAt: string         // ISO string
}

export interface SessionClaims {
  uid: string
  email: string
  activeCompanyId: string
  role: Role
}
