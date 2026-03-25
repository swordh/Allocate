export type EquipmentStatus = 'available' | 'checked_out' | 'needs_repair'

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
  requiresApproval: boolean   // triggers approval flow when booked
  approverId: string | null   // specific user who must approve; Admin if null
}
