'use server'

// Full implementation in Phase 2.

import { getVerifiedSession } from '@/lib/dal'

export async function createEquipment(_formData: FormData): Promise<{ id: string } | { error: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }
  console.log('[actions/equipment]', { uid: session.uid, action: 'create_equipment_stub' })
  return { error: 'Not implemented — Phase 2' }
}

export async function updateEquipment(
  _equipmentId: string,
  _formData: FormData,
): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }
  console.log('[actions/equipment]', { uid: session.uid, action: 'update_equipment_stub' })
  return { error: 'Not implemented — Phase 2' }
}

export async function deleteEquipment(_equipmentId: string): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }
  console.log('[actions/equipment]', { uid: session.uid, action: 'delete_equipment_stub' })
  return { error: 'Not implemented — Phase 2' }
}
