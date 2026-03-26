import 'server-only'

import { cache } from 'react'
import { adminDb } from '@/lib/firebase-admin'
import type { Equipment } from '@/types'

function docToEquipment(doc: FirebaseFirestore.DocumentSnapshot): Equipment {
  const data = doc.data() ?? {}
  return {
    id:               doc.id,
    name:             data.name             ?? '',
    category:         data.category         ?? '',
    icon:             data.icon             ?? undefined,
    active:           data.active           ?? true,
    status:           data.status           ?? 'available',
    trackingType:     data.trackingType     ?? 'individual',
    totalQuantity:    data.totalQuantity    ?? 1,
    serialNumber:     data.serialNumber     ?? null,
    requiresApproval: data.requiresApproval ?? false,
    approverId:       data.approverId       ?? null,
    createdAt:        data.createdAt?.toDate?.()?.toISOString() ?? data.createdAt ?? null,
  }
}

/**
 * Fetches active equipment for a company, sorted by category then name.
 * Wrapped in React.cache — multiple Server Components sharing the same
 * companyId in a single render pass incur only one Firestore read.
 */
export const getEquipment = cache(async (companyId: string): Promise<Equipment[]> => {
  const snapshot = await adminDb
    .collection('companies')
    .doc(companyId)
    .collection('equipment')
    .where('active', '==', true)
    .orderBy('category', 'asc')
    .orderBy('name', 'asc')
    .get()

  return snapshot.docs.map(docToEquipment)
})
