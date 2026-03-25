'use client'

import { useEffect, useState } from 'react'
import { collection, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import type { Role } from '@/types'

export interface Member {
  uid: string
  name: string
  role: Role
}

export function useMembers(companyId: string) {
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!companyId) return

    getDocs(collection(db, 'companies', companyId, 'memberships'))
      .then((snapshot) => {
        const data = snapshot.docs.map((doc) => {
          const d = doc.data()
          return {
            uid: doc.id,
            name: (d.name as string | undefined) ?? d.email ?? doc.id,
            role: d.role as Role,
          }
        })
        setMembers(data)
      })
      .catch((err) => {
        console.error('[useMembers] Failed to fetch members:', err)
      })
      .finally(() => {
        setLoading(false)
      })
  }, [companyId])

  return { members, loading }
}
