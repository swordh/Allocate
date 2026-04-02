'use client'

import { useState } from 'react'
import { useEquipment } from '@/hooks/useEquipment'
import { deactivateEquipment, toggleEquipmentAvailability } from '@/actions/equipment'
import EquipmentEmpty from './EquipmentEmpty'
import EquipmentModal from './EquipmentModal'
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
  available:    'Available',
  checked_out:  'Checked Out',
  needs_repair: 'Needs Repair',
}

function getStatusDotClass(status: EquipmentStatus): string {
  switch (status) {
    case 'available':    return styles.statusDotAvailable
    case 'checked_out':  return styles.statusDotCheckedOut
    case 'needs_repair': return styles.statusDotNeedsRepair
  }
}

function getUnitStatusTextClass(status: EquipmentStatus): string {
  switch (status) {
    case 'available':    return styles.unitStatusAvailable
    case 'checked_out':  return styles.unitStatusCheckedOut
    case 'needs_repair': return styles.unitStatusNeedsRepair
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

  // Quantity / add-new modal
  const [modalOpen, setModalOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<Equipment | undefined>(undefined)

  // Combined serialized edit modal
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editModalEquipment, setEditModalEquipment] = useState<Equipment | undefined>(undefined)

  const [deactivatingId, setDeactivatingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [togglingAvailabilityId, setTogglingAvailabilityId] = useState<string | null>(null)

  function openAddModal() {
    setEditingItem(undefined)
    setModalOpen(true)
  }

  function openEditModal(item: Equipment) {
    setEditingItem(item)
    setModalOpen(true)
  }

  function openEditSerializedModal(item: Equipment) {
    setEditModalEquipment(item)
    setEditModalOpen(true)
  }

  async function handleDeactivate(item: Equipment) {
    if (!confirm(`Delete "${item.name}"? It will no longer appear in the equipment list.`)) return
    setDeactivatingId(item.id)
    setActionError(null)
    const result = await deactivateEquipment(item.id)
    setDeactivatingId(null)
    if ('error' in result) setActionError(result.error)
  }

  async function handleToggleAvailability(item: Equipment) {
    setTogglingAvailabilityId(item.id)
    setActionError(null)
    const result = await toggleEquipmentAvailability(item.id, !item.availableForBooking)
    setTogglingAvailabilityId(null)
    if (result.error) {
      setActionError(result.error)
    }
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
      {/* Page header with Add Equipment button for admins */}
      <div className={styles.header}>
        <h1 className={styles.pageTitle}>Equipment</h1>
        {role === 'admin' && (
          <button className={styles.addBtn} onClick={openAddModal}>
            Add Equipment
          </button>
        )}
      </div>

      {actionError && (
        <div className={styles.actionError}>
          <p>{actionError}</p>
        </div>
      )}

      {equipment.length === 0 ? (
        <EquipmentEmpty role={role} onAddClick={openAddModal} />
      ) : (
        <div className={styles.list}>
          {categories.map((cat) => {
            const items = grouped[cat]

            // Separate quantity items (flat) from serialized items (group header + unit rows)
            const quantityItems = items.filter((i) => i.trackingType === 'quantity' || !i.trackingType)
            const serializedItems = items.filter((i) => i.trackingType === 'serialized')

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
                    <div className={styles.rowLeft}>
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
                          className={item.availableForBooking ? styles.availabilityBtnAvailable : styles.availabilityBtnUnavailable}
                          onClick={() => handleToggleAvailability(item)}
                          disabled={togglingAvailabilityId === item.id}
                        >
                          {togglingAvailabilityId === item.id
                            ? '...'
                            : item.availableForBooking
                              ? 'Available'
                              : 'Unavailable'}
                        </button>
                        <button
                          className={styles.editBtn}
                          onClick={() => openEditModal(item)}
                        >
                          Edit
                        </button>
                        <button
                          className={styles.deactivateBtn}
                          onClick={() => handleDeactivate(item)}
                          disabled={deactivatingId === item.id}
                        >
                          {deactivatingId === item.id ? 'Deleting...' : 'Delete'}
                        </button>
                      </div>
                    )}
                  </div>
                ))}

                {/* Serialized items — collapsible group with combined edit modal */}
                {serializedItems.map((eq) => (
                  <details key={eq.id} className={styles.group} open>
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
                            onClick={(e) => { e.preventDefault(); openEditSerializedModal(eq) }}
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
                          <span className={`${styles.statusDot} ${getStatusDotClass(unit.status)}`} />
                          <span className={styles.unitName}>{unit.label}</span>
                          {unit.serialNumber && (
                            <span className={styles.serialNumber}>S/N {unit.serialNumber}</span>
                          )}
                        </div>
                        <div className={styles.unitRowRight}>
                          <span className={`${styles.unitStatusText} ${getUnitStatusTextClass(unit.status)}`}>
                            {UNIT_STATUS_LABELS[unit.status]}
                          </span>
                        </div>
                      </div>
                    ))}

                    {/* Add unit — opens edit modal */}
                    {role === 'admin' && (
                      <div className={styles.addUnitRow}>
                        <button
                          className={styles.addUnitLink}
                          onClick={(e) => { e.preventDefault(); openEditSerializedModal(eq) }}
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

      <EquipmentModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        companyId={companyId}
        equipment={editingItem}
      />

      {editModalEquipment && (
        <EquipmentEditModal
          isOpen={editModalOpen}
          onClose={() => setEditModalOpen(false)}
          companyId={companyId}
          equipment={editModalEquipment}
        />
      )}
    </>
  )
}
