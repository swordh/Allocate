'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useEquipment } from '@/hooks/useEquipment'
import EquipmentEmpty from './EquipmentEmpty'
import EquipmentEditModal from './EquipmentEditModal'
import type { Equipment, EquipmentStatus, Role } from '@/types'
import styles from './EquipmentList.module.css'

interface EquipmentListProps {
  companyId: string
  role: Role
  initialEquipment: Equipment[]
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const UNIT_STATUS_LABELS: Record<EquipmentStatus, string> = {
  ok:                 'Ok',
  needs_repair:       'Needs Repair',
  limited_operations: 'Limited Operations',
}

function getStatusDotClass(status: EquipmentStatus): string {
  switch (status) {
    case 'ok':                 return styles.statusDotOk
    case 'needs_repair':       return styles.statusDotNeedsRepair
    case 'limited_operations': return styles.statusDotLimitedOperations
  }
}

function getUnitStatusTextClass(status: EquipmentStatus): string {
  switch (status) {
    case 'ok':                 return styles.unitStatusOk
    case 'needs_repair':       return styles.unitStatusNeedsRepair
    case 'limited_operations': return styles.unitStatusLimitedOperations
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function EquipmentList({ companyId, role, initialEquipment }: EquipmentListProps) {
  // Real-time listener replaces the server-fetched initial data.
  // initialEquipment seeds the UI with SSR data while the listener connects.
  const { equipment: liveEquipment, loading, error } = useEquipment(companyId)
  const equipment = loading ? initialEquipment : liveEquipment

  // ?add=1 in the URL (from the mobile menu CTA) opens the add modal on mount.
  const searchParams = useSearchParams()
  const openOnMount = role === 'admin' && searchParams.get('add') === '1'

  // Unified modal state — pre-open if ?add=1 was present on first render
  const [unifiedModalOpen, setUnifiedModalOpen] = useState(openOnMount)
  const [unifiedModalEquipment, setUnifiedModalEquipment] = useState<Equipment | undefined>(undefined)

  function openAddModal() {
    setUnifiedModalEquipment(undefined)
    setUnifiedModalOpen(true)
  }

  function openEditModal(item: Equipment) {
    setUnifiedModalEquipment(item)
    setUnifiedModalOpen(true)
  }

  if (error) {
    return (
      <div className={styles.errorState}>
        <p>Failed to load equipment. Please refresh the page.</p>
        {process.env.NODE_ENV === 'development' && (
          <p className={styles.errorDetail}>{error.message}</p>
        )}
      </div>
    )
  }

  // Group equipment by category
  const grouped = equipment.reduce<Record<string, Equipment[]>>((acc, item) => {
    const cat = item.category || 'Uncategorized'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(item)
    return acc
  }, {})

  const categories = Object.keys(grouped).sort()

  return (
    <>
      {/* Mobile-only primary action under the page title */}
      {role === 'admin' && (
        <div className={styles.mobileAction}>
          <button className={styles.mobileActionBtn} onClick={openAddModal}>
            New Equipment
          </button>
        </div>
      )}

      {equipment.length === 0 ? (
        <EquipmentEmpty role={role} onAddClick={openAddModal} />
      ) : (
        <div className={styles.list}>
          {categories.map((cat) => {
            const items = grouped[cat]

            // Separate quantity items (flat) from unit-tracked items (group header + unit rows)
            const quantityItems = items.filter((i) => i.trackingType === 'quantity' || !i.trackingType)
            const unitItems = items.filter((i) => i.trackingType === 'units')

            return (
              <section key={cat} className={styles.category}>
                <div className={styles.categoryHeader}>
                  <h2 className={styles.categoryHeaderLabel}>{cat}</h2>
                  <div className={styles.categoryHeaderRule} />
                  <span className={styles.categoryHeaderCount}>{items.length}</span>
                </div>

                {/* Quantity items render flat */}
                {quantityItems.map((item) => (
                  <div key={item.id} className={styles.row}>
                    <div className={`${styles.rowLeft} ${styles.rowLeftQty}`}>
                      <span className={styles.name}>{item.name}</span>
                      {item.trackingType === 'quantity' && (
                        <>
                          <span className={styles.trackingTypeBadge}>Qty</span>
                          <span className={styles.quantityInfo}>
                            <strong>{item.totalQuantity}</strong> available
                          </span>
                        </>
                      )}
                      {!item.trackingType && (
                        <span className={styles.legacyBadge}>Legacy</span>
                      )}
                    </div>
                    {role === 'admin' && (
                      <div className={styles.rowActions}>
                        <button
                          className={styles.editBtn}
                          onClick={() => openEditModal(item)}
                        >
                          Edit
                        </button>
                      </div>
                    )}
                  </div>
                ))}

                {/* Unit-tracked items — collapsible group with unified edit modal */}
                {unitItems.map((eq) => (
                  <details key={eq.id} className={styles.group}>
                    <summary className={styles.groupHeader}>
                      <div className={styles.rowLeft}>
                        <span className={`material-symbols-outlined ${styles.chevron}`}>
                          expand_more
                        </span>
                        <span className={styles.name}>{eq.name}</span>
                        <span className={styles.trackingTypeBadge}>Units</span>
                      </div>
                      {role === 'admin' && (
                        <div className={styles.rowActions}>
                          <button
                            className={styles.editBtn}
                            onClick={(e) => { e.preventDefault(); openEditModal(eq) }}
                          >
                            Edit
                          </button>
                        </div>
                      )}
                    </summary>

                    {/* Unit rows */}
                    {(eq.units ?? []).map((unit) => (
                      <div key={unit.id} className={styles.unitRow}>
                        <div className={styles.rowLeft}>
                          {/* Status dot hidden for MVP — <span className={`${styles.statusDot} ${getStatusDotClass(unit.status)}`} /> */}
                          <span className={styles.unitName}>{unit.label}</span>
                          {unit.serialNumber && (
                            <span className={styles.serialNumber}>S/N {unit.serialNumber}</span>
                          )}
                        </div>
                        {/* Status text hidden for MVP
                        <div className={styles.unitRowRight}>
                          <span className={`${styles.unitStatusText} ${getUnitStatusTextClass(unit.status)}`}>
                            {UNIT_STATUS_LABELS[unit.status]}
                          </span>
                        </div>
                        */}
                      </div>
                    ))}

                    {/* Add unit — opens edit modal */}
                    {role === 'admin' && (
                      <div className={styles.addUnitRow}>
                        <button
                          className={styles.addUnitLink}
                          onClick={(e) => { e.preventDefault(); openEditModal(eq) }}
                        >
                          + Add Unit
                        </button>
                      </div>
                    )}
                  </details>
                ))}
              </section>
            )
          })}
        </div>
      )}

      <EquipmentEditModal
        isOpen={unifiedModalOpen}
        onClose={() => setUnifiedModalOpen(false)}
        companyId={companyId}
        equipment={unifiedModalEquipment}
      />
    </>
  )
}
