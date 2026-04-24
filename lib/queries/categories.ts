import 'server-only'

import { cache } from 'react'
import { adminDb } from '@/lib/firebase-admin'
import type { Category } from '@/types'

function docToCategory(doc: FirebaseFirestore.DocumentSnapshot): Category {
  const data = doc.data() ?? {}
  return {
    id:                   doc.id,
    name:                 data.name                 ?? '',
    isDefault:            data.isDefault            ?? false,
    createdAt:            data.createdAt?.toDate?.()?.toISOString() ?? data.createdAt ?? null,
    customFieldTemplates: data.customFieldTemplates ?? [],
  }
}

export const getCategories = cache(async (companyId: string): Promise<Category[]> => {
  const snapshot = await adminDb
    .collection('companies')
    .doc(companyId)
    .collection('categories')
    .get()

  const categories = snapshot.docs.map(docToCategory)

  // Sort by createdAt asc — nulls last
  categories.sort((a, b) => {
    if (!a.createdAt && !b.createdAt) return 0
    if (!a.createdAt) return 1
    if (!b.createdAt) return -1
    return a.createdAt.localeCompare(b.createdAt)
  })

  return categories
})
