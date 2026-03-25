import 'server-only'

import { cache } from 'react'
import { adminDb } from '@/lib/firebase-admin'
import type { Company } from '@/types'

/**
 * Fetches a company document by ID.
 * Full implementation in Phase 2.
 */
export const getCompany = cache(async (companyId: string): Promise<Company | null> => {
  const doc = await adminDb.collection('companies').doc(companyId).get()
  if (!doc.exists) return null
  return { id: doc.id, ...doc.data() } as Company
})
