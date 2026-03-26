export type EquipmentStatus = 'available' | 'checked_out' | 'needs_repair'

// Immutable after creation.
// 'individual' = one document per physical unit (serial number optional)
// 'quantity'   = one document represents a pool of interchangeable items
export type TrackingType = 'individual' | 'quantity'

// Default categories seeded for every new company
export const DEFAULT_EQUIPMENT_CATEGORIES = [
  'Camera',
  'Lenses',
  'Audio',
  'Lighting',
  'Grip',
  'Accessories',
] as const

export interface Equipment {
  id: string
  name: string
  category: string            // from company's category list
  icon?: string
  active: boolean
  status: EquipmentStatus
  trackingType: TrackingType  // immutable after creation
  totalQuantity: number       // always 1 for individual; >= 1 for quantity
  serialNumber: string | null // optional for individual; always null for quantity
  requiresApproval: boolean   // triggers approval flow when booked
  approverId: string | null   // specific user who must approve; Admin if null
  createdAt: string | null    // ISO string (converted from Timestamp at read boundary)
}
