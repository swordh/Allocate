'use client'

import { useState } from 'react'
import { useEquipment } from '@/hooks/useEquipment'
import { deactivateEquipment } from '@/actions/equipment'
import EquipmentStatusBadge from './EquipmentStatusBadge'
import EquipmentEmpty from './EquipmentEmpty'
import EquipmentModal from './EquipmentModal'
import type { Equipment, Role } from '@/types'
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

  function openAddModal() {
    setEditingItem(undefined)
    setModalOpen(true)
  }

  function openEditModal(item: Equipment) {
    setEditingItem(item)
    setModalOpen(true)
  }

  async function handleDeactivate(item: Equipment) {
    if (!confirm(`Deactivate "${item.name}"? It will no longer appear in the equipment list.`)) {
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

            // Separate quantity items (flat) from individual items (grouped by name)
            const quantityItems = items.filter((i) => i.trackingType === 'quantity' || !i.trackingType)
            const individualItems = items.filter((i) => i.trackingType === 'individual')

            // Group individual items by equipmentName (parent name).
            // Fall back to item.name for legacy units that predate this field.
            const individualGroups = individualItems.reduce<Record<string, Equipment[]>>((acc, item) => {
              const key = item.equipmentName ?? item.name
              if (!acc[key]) acc[key] = []
              acc[key].push(item)
              return acc
            }, {})
            const individualGroupNames = Object.keys(individualGroups)

            return (
              <section key={cat} className={styles.category}>
                <h2 className={styles.categoryHeader}>{cat}</h2>

                {/* Quantity items render flat, same as before */}
                {quantityItems.map((item) => (
                  <div key={item.id} className={styles.row}>
                    <div className={styles.rowLeft}>
                      <EquipmentStatusBadge status={item.status} />
                      <span className={styles.name}>{item.name}</span>
                      {item.trackingType === 'quantity' && (
                        <span className={styles.quantityBadge}>×{item.totalQuantity}</span>
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
                          {deactivatingId === item.id ? 'Deactivating…' : 'Deactivate'}
                        </button>
                      </div>
                    )}
                  </div>
                ))}

                {/* Individual items render as a parent group header + indented unit rows */}
                {individualGroupNames.map((parentName) => (
                  <div key={parentName} className={styles.group}>
                    {/* Parent row — shows the equipment name and admin actions */}
                    <div className={styles.groupHeader}>
                      <div className={styles.rowLeft}>
                        <span className={styles.name}>{parentName}</span>
                        <span className={styles.categoryPill}>{cat}</span>
                      </div>
                      {role === 'admin' && (
                        <div className={styles.rowActions}>
                          <button
                            className={styles.editBtn}
                            onClick={() => openEditModal(individualGroups[parentName][0])}
                          >
                            Edit
                          </button>
                          <button
                            className={styles.deactivateBtn}
                            onClick={() => handleDeactivate(individualGroups[parentName][0])}
                            disabled={individualGroups[parentName].some((u) => deactivatingId === u.id)}
                          >
                            {individualGroups[parentName].some((u) => deactivatingId === u.id)
                              ? 'Deactivating…'
                              : 'Deactivate'}
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Unit rows — indented children */}
                    {individualGroups[parentName].map((unit) => (
                      <div key={unit.id} className={styles.unitRow}>
                        <div className={styles.rowLeft}>
                          <EquipmentStatusBadge status={unit.status} />
                          <span className={styles.unitName}>{unit.name}</span>
                          {unit.serialNumber && (
                            <span className={styles.serialNumber}>{unit.serialNumber}</span>
                          )}
                        </div>
                        {role === 'admin' && (
                          <div className={styles.rowActions}>
                            <button
                              className={styles.editBtn}
                              onClick={() => openEditModal(unit)}
                            >
                              Edit
                            </button>
                            <button
                              className={styles.deactivateBtn}
                              onClick={() => handleDeactivate(unit)}
                              disabled={deactivatingId === unit.id}
                            >
                              {deactivatingId === unit.id ? 'Deactivating…' : 'Deactivate'}
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
    </>
  )
}
