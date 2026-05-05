'use client'

import { useEffect, useState } from 'react'
import { collection, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import type { Category } from '@/types'

export function useCategories(companyId: string) {
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!companyId) return

    getDocs(collection(db, 'companies', companyId, 'categories'))
      .then((snapshot) => {
        const data = snapshot.docs.map((doc) => ({
          id: doc.id,
          name: doc.data().name as string,
          isDefault: doc.data().isDefault ?? false,
          createdAt: doc.data().createdAt?.toDate?.()?.toISOString() ?? null,
          customFieldTemplates: doc.data().customFieldTemplates ?? [],
        })).sort((a, b) => a.name.localeCompare(b.name))
        setCategories(data)
      })
      .catch((err) => {
        console.error('[useCategories] Failed to fetch categories:', err)
      })
      .finally(() => {
        setLoading(false)
      })
  }, [companyId])

  return { categories, loading }
}
