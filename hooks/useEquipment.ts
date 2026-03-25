'use client'

import { useEffect, useState } from 'react'
import { collection, query, where, onSnapshot } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import type { Equipment } from '@/types'

export function useEquipment(companyId: string) {
  const [equipment, setEquipment] = useState<Equipment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!companyId) return

    const q = query(
      collection(db, 'companies', companyId, 'equipment'),
      where('active', '==', true),
    )

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Equipment))
        setEquipment(data)
        setLoading(false)
      },
      (err) => {
        console.error('[useEquipment] Firestore listener error:', err)
        setError(err)
        setLoading(false)
      },
    )

    return unsubscribe
  }, [companyId])

  return { equipment, loading, error }
}
