export type EquipmentStatus = 'available' | 'checked_out' | 'needs_repair'

// 'serialized' = one parent doc per equipment type, one subcollection doc per physical unit
// 'quantity'   = one document represents a pool of interchangeable items
export type TrackingType = 'serialized' | 'quantity'
export type UnitCondition = 'new' | 'good' | 'fair' | 'poor'

// Default categories seeded for every new company
export const DEFAULT_EQUIPMENT_CATEGORIES = [
  'Camera', 'Lenses', 'Audio', 'Lighting', 'Grip', 'Accessories',
] as const

export interface Equipment {
  id: string
  name: string
  description: string | null
  category: string            // from company's category list
  icon?: string
  active: boolean
  trackingType: TrackingType  // immutable after creation
  totalQuantity: number       // always 1 for serialized; >= 1 for quantity
  requiresApproval: boolean   // triggers approval flow when booked
  approverId: string | null   // specific user who must approve; Admin if null
  createdAt: string | null    // ISO string (converted from Timestamp at read boundary)
  units?: EquipmentUnit[]     // hydrated at query time, never stored in Firestore
}

export interface EquipmentUnit {
  id: string
  equipmentId: string   // denormalized parent ref
  companyId: string     // denormalized for collectionGroup queries
  label: string         // e.g. "Kamera 1"
  serialNumber: string | null
  status: EquipmentStatus
  condition: UnitCondition
  notes: string | null
  active: boolean
  createdAt: string | null
}
