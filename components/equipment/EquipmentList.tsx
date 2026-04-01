'use client'

import { useState } from 'react'
import { useEquipment } from '@/hooks/useEquipment'
import { deactivateEquipment, deactivateUnit } from '@/actions/equipment'
import EquipmentStatusBadge from './EquipmentStatusBadge'
import EquipmentEmpty from './EquipmentEmpty'
import EquipmentModal from './EquipmentModal'
import { UnitModal } from './UnitModal'
import type { Equipment, EquipmentUnit, Role } from '@/types'
import styles from './EquipmentList.module.css'

interface EquipmentListProps {
  companyId: string
  role: Role
  initialEquipment: Equipment[]
}

export default function EquipmentList({ companyId, role, initialEquipment }: EquipmentListProps) {
  // Real-time listener replaces the server-fetched initial data.
  // initialEquipment seeds the UI with SSR data while the listener connects.
  const { equipment: liveEquipment, loading, error } = useEquipment(companyId)
  const equipment = loading ? initialEquipment : liveEquipment

  const [modalOpen, setModalOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<Equipment | undefined>(undefined)
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // Unit modal state
  const [unitModalOpen, setUnitModalOpen] = useState(false)
  const [selectedUnit, setSelectedUnit] = useState<EquipmentUnit | undefined>(undefined)
  const [selectedEquipmentId, setSelectedEquipmentId] = useState<string>('')
  const [deactivatingUnitId, setDeactivatingUnitId] = useState<string | null>(null)

  function openAddModal() {
    setEditingItem(undefined)
    setModalOpen(true)
  }

  function openEditModal(item: Equipment) {
    setEditingItem(item)
    setModalOpen(true)
  }

  function openAddUnitModal(equipmentId: string) {
    setSelectedEquipmentId(equipmentId)
    setSelectedUnit(undefined)
    setUnitModalOpen(true)
  }

  function openEditUnitModal(equipmentId: string, unit: EquipmentUnit) {
    setSelectedEquipmentId(equipmentId)
    setSelectedUnit(unit)
    setUnitModalOpen(true)
  }

  async function handleDeactivate(item: Equipment) {
    if (!confirm(`Delete "${item.name}"? It will no longer appear in the equipment list.`)) {
      return
    }
    setDeactivatingId(item.id)
    setActionError(null)
    const result = await deactivateEquipment(item.id)
    setDeactivatingId(null)
    if ('error' in result) {
      setActionError(result.error)
    }
  }

  async function handleDeactivateUnit(equipmentId: string, unit: EquipmentUnit) {
    if (!confirm(`Delete unit "${unit.label}"? It will no longer appear in the equipment list.`)) {
      return
    }
    setDeactivatingUnitId(unit.id)
    setActionError(null)
    const result = await deactivateUnit(equipmentId, unit.id)
    setDeactivatingUnitId(null)
    if (result && 'error' in result) {
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
                        <span className={styles.quantityBadge}>x{item.totalQuantity}</span>
                      )}
                      {!item.trackingType && (
                        <span className={styles.legacyBadge}>Legacy</span>
                      )}
                      <span className={styles.categoryPill}>{item.category}</span>
                    </div>
                    {role === 'admin' && (
                      <div className={styles.rowActions}>
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

                {/* Serialized items render as a parent group header + indented unit rows */}
                {serializedItems.map((eq) => (
                  <div key={eq.id} className={styles.group}>
                    {/* Parent row — shows the equipment name and admin actions */}
                    <div className={styles.groupHeader}>
                      <div className={styles.rowLeft}>
                        <span className={styles.name}>{eq.name}</span>
                        <span className={styles.categoryPill}>{cat}</span>
                      </div>
                      {role === 'admin' && (
                        <div className={styles.rowActions}>
                          <button
                            className={styles.editBtn}
                            onClick={() => openAddUnitModal(eq.id)}
                          >
                            Add Unit
                          </button>
                          <button
                            className={styles.editBtn}
                            onClick={() => openEditModal(eq)}
                          >
                            Edit
                          </button>
                          <button
                            className={styles.deactivateBtn}
                            onClick={() => handleDeactivate(eq)}
                            disabled={deactivatingId === eq.id}
                          >
                            {deactivatingId === eq.id ? 'Deleting...' : 'Delete'}
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Unit rows — indented children */}
                    {(eq.units ?? []).map((unit) => (
                      <div key={unit.id} className={styles.unitRow}>
                        <div className={styles.rowLeft}>
                          <EquipmentStatusBadge status={unit.status} />
                          <span className={styles.unitName}>{unit.label}</span>
                          {unit.serialNumber && (
                            <span className={styles.serialNumber}>{unit.serialNumber}</span>
                          )}
                        </div>
                        {role === 'admin' && (
                          <div className={styles.rowActions}>
                            <button
                              className={styles.editBtn}
                              onClick={() => openEditUnitModal(eq.id, unit)}
                            >
                              Edit
                            </button>
                            <button
                              className={styles.deactivateBtn}
                              onClick={() => handleDeactivateUnit(eq.id, unit)}
                              disabled={deactivatingUnitId === unit.id}
                            >
                              {deactivatingUnitId === unit.id ? 'Deleting...' : 'Delete'}
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
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

      <UnitModal
        isOpen={unitModalOpen}
        onClose={() => setUnitModalOpen(false)}
        equipmentId={selectedEquipmentId}
        unit={selectedUnit}
      />
    </>
  )
}
