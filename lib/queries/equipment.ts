import 'server-only'

import { cache } from 'react'
import { adminDb } from '@/lib/firebase-admin'
import type { Equipment, EquipmentUnit } from '@/types'

function docToEquipment(doc: FirebaseFirestore.DocumentSnapshot): Equipment {
  const data = doc.data() ?? {}
  return {
    id:               doc.id,
    name:             data.name             ?? '',
    description:      data.description      ?? null,
    category:         data.category         ?? '',
    icon:             data.icon             ?? undefined,
    active:           data.active           ?? true,
    trackingType:     data.trackingType     ?? 'serialized',
    totalQuantity:    data.totalQuantity    ?? 1,
    requiresApproval:     data.requiresApproval     ?? false,
    approverId:           data.approverId           ?? null,
    availableForBooking:  data.availableForBooking !== false, // !==false defaults existing docs (no field) to true
    createdAt:        data.createdAt?.toDate?.()?.toISOString() ?? data.createdAt ?? null,
    customFields:     Array.isArray(data.customFields) ? data.customFields : [],
  }
}

function docToUnit(doc: FirebaseFirestore.DocumentSnapshot): EquipmentUnit {
  const data = doc.data() ?? {}
  return {
    id:           doc.id,
    equipmentId:  data.equipmentId  ?? '',
    companyId:    data.companyId    ?? '',
    label:        data.label        ?? '',
    serialNumber: data.serialNumber ?? null,
    status:       data.status       ?? 'available',
    notes:        data.notes        ?? null,
    active:       data.active       ?? true,
    createdAt:    data.createdAt?.toDate?.()?.toISOString() ?? data.createdAt ?? null,
  }
}

/**
 * Fetches active equipment for a company, sorted by category then name.
 * Uses two parallel queries: parent equipment docs + collectionGroup units,
 * then stitches them together.
 * Wrapped in React.cache — multiple Server Components sharing the same
 * companyId in a single render pass incur only one Firestore read.
 */
export const getEquipment = cache(async (companyId: string): Promise<Equipment[]> => {
  const [eqSnapshot, unitsSnapshot] = await Promise.all([
    adminDb.collection('companies').doc(companyId).collection('equipment')
      .where('active', '==', true)
      .orderBy('category', 'asc')
      .orderBy('name', 'asc')
      .get(),
    adminDb.collectionGroup('units')
      .where('companyId', '==', companyId)
      .where('active', '==', true)
      .get(),
  ])

  const unitsMap = new Map<string, EquipmentUnit[]>()
  for (const doc of unitsSnapshot.docs) {
    const unit = docToUnit(doc)
    if (!unitsMap.has(unit.equipmentId)) unitsMap.set(unit.equipmentId, [])
    unitsMap.get(unit.equipmentId)!.push(unit)
  }

  return eqSnapshot.docs.map((doc) => {
    const eq = docToEquipment(doc)
    return {
      ...eq,
      units: eq.trackingType === 'serialized' ? (unitsMap.get(eq.id) ?? []) : undefined,
    }
  })
})
