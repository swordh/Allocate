'use client'
import { useEffect, useMemo, useState } from 'react'
import { collection, collectionGroup, onSnapshot, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import type { Equipment, EquipmentUnit } from '@/types'

export function useEquipment(companyId: string) {
  const [equipmentMap, setEquipmentMap] = useState<Map<string, Equipment>>(new Map())
  const [unitsMap, setUnitsMap] = useState<Map<string, EquipmentUnit[]>>(new Map())
  const [loadingEquipment, setLoadingEquipment] = useState(true)
  const [loadingUnits, setLoadingUnits] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!companyId) return

    const eqQuery = query(
      collection(db, 'companies', companyId, 'equipment'),
      where('active', '==', true),
    )
    const unsubEquipment = onSnapshot(eqQuery, (snapshot) => {
      const map = new Map<string, Equipment>()
      snapshot.docs.forEach((doc) => map.set(doc.id, { id: doc.id, ...doc.data() } as Equipment))
      setEquipmentMap(map)
      setLoadingEquipment(false)
    }, (err) => { setError(err as Error); setLoadingEquipment(false) })

    const unitsQuery = query(
      collectionGroup(db, 'units'),
      where('companyId', '==', companyId),
      where('active', '==', true),
    )
    const unsubUnits = onSnapshot(unitsQuery, (snapshot) => {
      const map = new Map<string, EquipmentUnit[]>()
      snapshot.docs.forEach((doc) => {
        const unit = { id: doc.id, ...doc.data() } as EquipmentUnit
        if (!map.has(unit.equipmentId)) map.set(unit.equipmentId, [])
        map.get(unit.equipmentId)!.push(unit)
      })
      setUnitsMap(map)
      setLoadingUnits(false)
    }, (err) => { setError(err as Error); setLoadingUnits(false) })

    return () => { unsubEquipment(); unsubUnits() }
  }, [companyId])

  const equipment = useMemo(() => {
    const result: Equipment[] = []
    for (const eq of equipmentMap.values()) {
      result.push({
        ...eq,
        units: eq.trackingType === 'serialized' ? (unitsMap.get(eq.id) ?? []) : undefined,
      })
    }
    return result.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
  }, [equipmentMap, unitsMap])

  return { equipment, loading: loadingEquipment || loadingUnits, error }
}
