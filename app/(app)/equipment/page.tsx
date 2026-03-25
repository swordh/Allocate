import { getVerifiedSession } from '@/lib/dal'
import { getEquipment } from '@/lib/queries/equipment'
import EquipmentList from '@/components/equipment/EquipmentList'

/**
 * Equipment page — Server Component.
 * Fetches initial equipment via Admin SDK (one-shot read).
 * EquipmentList mounts a real-time Firestore listener that takes over after hydration.
 */
export default async function EquipmentPage() {
  const session = await getVerifiedSession()
  const initialEquipment = await getEquipment(session.activeCompanyId)

  return (
    <EquipmentList
      companyId={session.activeCompanyId}
      role={session.role}
      initialEquipment={initialEquipment}
    />
  )
}
