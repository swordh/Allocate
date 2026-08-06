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
    trackingType:     data.trackingType     ?? 'units',
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
    active:               data.active               ?? true,
    availableForBooking:  data.availableForBooking !== false,
    createdAt:    data.createdAt?.toDate?.()?.toISOString() ?? data.createdAt ?? null,
  }
}

/**
 * Fetches equipment for a company, sorted by category then name.
 * Uses two parallel queries: parent equipment docs + collectionGroup units,
 * then stitches them together.
 * Wrapped in React.cache — multiple Server Components sharing the same
 * companyId in a single render pass incur only one Firestore read.
 *
 * Pass `includeInactive: true` to also return soft-deleted equipment and units.
 * Default behaviour (false) returns only active items.
 */
export const getEquipment = cache(async (
  companyId: string,
  opts?: { includeInactive?: boolean },
): Promise<Equipment[]> => {
  const includeInactive = opts?.includeInactive ?? false

  const [eqSnapshot, unitsSnapshot] = await Promise.all([
    (() => {
      const ref = adminDb.collection('companies').doc(companyId).collection('equipment')
      const q = includeInactive ? ref : ref.where('active', '==', true)
      return q.orderBy('category', 'asc').orderBy('name', 'asc').get()
    })(),
    (() => {
      const base = adminDb.collectionGroup('units').where('companyId', '==', companyId)
      if (!includeInactive) return base.where('active', '==', true).get()
      // Run two queries to reuse existing (companyId, active) composite index
      return Promise.all([
        base.where('active', '==', true).get(),
        base.where('active', '==', false).get(),
      ]).then(([a, b]) => ({ docs: [...a.docs, ...b.docs] }))
    })(),
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
      units: eq.trackingType === 'units' ? (unitsMap.get(eq.id) ?? []) : undefined,
    }
  })
})

/**
 * Counts equipment docs (types, not units) per category, including inactive
 * equipment. Used for "<n> TYPES" tallies where the true count matters (e.g.
 * before allowing a category delete) but the caller has no use for the full
 * Equipment objects or their units.
 *
 * Uses a `.select('category')` projection over the equipment collection only
 * — no units collectionGroup join — since only the category field is needed.
 * Wrapped in React.cache like the other queries in this file.
 */
export const getEquipmentCategoryCounts = cache(async (
  companyId: string,
): Promise<Record<string, number>> => {
  const snapshot = await adminDb
    .collection('companies')
    .doc(companyId)
    .collection('equipment')
    .select('category')
    .get()

  const counts: Record<string, number> = {}
  for (const doc of snapshot.docs) {
    const category = (doc.get('category') as string | undefined) ?? ''
    counts[category] = (counts[category] ?? 0) + 1
  }
  return counts
})
