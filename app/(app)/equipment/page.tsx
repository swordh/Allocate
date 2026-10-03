import { Suspense } from 'react'
import { getVerifiedSession } from '@/lib/dal'
import { getEquipment } from '@/lib/queries/equipment'
import { getCompany, getEquipmentCount } from '@/lib/queries/company'
import EquipmentList from '@/components/equipment/EquipmentList'

/**
 * Equipment page — Server Component.
 * Fetches initial equipment via Admin SDK (one-shot read).
 * EquipmentList mounts a real-time Firestore listener that takes over after hydration.
 * Suspense required because EquipmentList uses useSearchParams().
 */
export default async function EquipmentPage() {
  const session = await getVerifiedSession()
  const [initialEquipment, equipmentCount, company] = await Promise.all([
    getEquipment(session.activeCompanyId),
    getEquipmentCount(session.activeCompanyId),
    getCompany(session.activeCompanyId),
  ])

  return (
    <Suspense>
      <EquipmentList
        companyId={session.activeCompanyId}
        role={session.role}
        initialEquipment={initialEquipment}
        initialEquipmentCount={equipmentCount}
        // Disables the add controls when full. UX only — the server actions enforce it.
        // No subscription on the doc → Infinity: don't grey anything out on a guess.
        equipmentLimit={company?.subscription?.limits?.equipment ?? Infinity}
      />
    </Suspense>
  )
}
