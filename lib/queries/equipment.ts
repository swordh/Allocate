import 'server-only'

import { cache } from 'react'
import { adminDb } from '@/lib/firebase-admin'
import type { Equipment } from '@/types'

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

  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Equipment))
})
