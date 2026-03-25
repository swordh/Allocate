import 'server-only'

import { cache } from 'react'
import { adminDb } from '@/lib/firebase-admin'
import type { Equipment } from '@/types'

/**
 * Fetches active equipment for a company.
 * Wrapped in React.cache — multiple Server Components in the same render
 * pass sharing companyId incur only one Firestore read.
 *
 * Full implementation in Phase 2.
 */
export const getEquipment = cache(async (companyId: string): Promise<Equipment[]> => {
  const snapshot = await adminDb
    .collection('companies').doc(companyId)
    .collection('equipment')
    .where('active', '==', true)
    .get()

  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Equipment))
})
