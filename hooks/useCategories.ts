'use client'

import { useEffect, useState } from 'react'
import { collection, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase'

export interface Category {
  id: string
  name: string
}

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
        }))
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
