'use server'

import { FieldValue } from 'firebase-admin/firestore'
import { revalidatePath } from 'next/cache'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { equipmentCountDelta, assertEquipmentCapacity } from '@/lib/companyStats'
import type { EquipmentStatus, CustomField, TrackingType } from '@/types'

// ── Internal Firestore document shapes ──────────────────────────────────────

interface EquipmentDocumentInternal {
  trackingType?: string
  totalQuantity?: number
  active: boolean
  name: string
}

// A type with no `trackingType` predates quantity tracking and behaves as `units`
// (same reading as lib/queries/equipment.ts). Only `quantity` types count by
// `totalQuantity`; every other type counts its active unit documents.
function isQuantityTracked(data: { trackingType?: string }): boolean {
  return data.trackingType === 'quantity'
}

// Errors thrown inside a transaction whose message is safe to show the user.
const USER_FACING_CODES = ['resource-exhausted', 'failed-precondition', 'not-found']

// ── createEquipment ──────────────────────────────────────────────────────────

export async function createEquipment(
  formData: FormData,
): Promise<{ id: string } | { error: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  const companyId = session.activeCompanyId

  // ── Input validation ───────────────────────────────────────────────────────
  const name = (formData.get('name') as string | null)?.trim() ?? ''
  if (!name) return { error: 'Name is required' }
  if (name.length > 100) return { error: 'Name must be 100 characters or fewer' }

  const category = (formData.get('category') as string | null)?.trim() ?? ''
  if (!category) return { error: 'Category is required' }

  const description = (formData.get('description') as string | null)?.trim() || null

  const trackingType =
    (formData.get('trackingType') as string | null) === 'quantity' ? 'quantity' : 'units'

  let totalQuantity = 1
  if (trackingType === 'quantity') {
    const raw = parseInt(formData.get('totalQuantity') as string ?? '0', 10)
    if (!Number.isInteger(raw) || raw < 1) {
      return { error: 'totalQuantity must be a positive integer for quantity items' }
    }
    totalQuantity = raw
  }

  const requiresApproval = formData.get('requiresApproval') === 'true'
  const approverIdRaw = formData.get('approverId') as string | null
  const approverId: string | null = approverIdRaw?.trim() || null

  const customFieldsRaw = formData.get('customFields') as string | null
  const customFields = customFieldsRaw ? JSON.parse(customFieldsRaw) : []

  // ── Transaction: check plan limit + write atomically ──────────────────────
  let newEquipmentId: string

  try {
    await adminDb.runTransaction(async (tx) => {
      // A `units` type starts with no units and so occupies nothing yet; a
      // `quantity` type occupies its whole totalQuantity from the start.
      const adding = trackingType === 'quantity' ? totalQuantity : 0

      // Reads company + counter — ALL reads must come before writes.
      await assertEquipmentCapacity(tx, companyId, adding)

      const newRef = adminDb.collection(`companies/${companyId}/equipment`).doc()
      newEquipmentId = newRef.id

      // Increment counter atomically with the equipment write.
      equipmentCountDelta(tx, companyId, adding)

      tx.set(newRef, {
        name,
        description,
        category,
        trackingType,
        totalQuantity,
        active: true,
        requiresApproval,
        approverId,
        customFields,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: session.uid,
      })
    })

    revalidatePath('/equipment')
    revalidatePath('/settings/equipment')

    return { id: newEquipmentId! }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create equipment'
    console.error('[actions/equipment] createEquipment failed', { message })
    return { error: message }
  }
}

// ── updateEquipment ──────────────────────────────────────────────────────────

export async function updateEquipment(
  equipmentId: string,
  formData: FormData,
): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  const companyId = session.activeCompanyId

  if (!equipmentId?.trim()) return { error: 'equipmentId is required' }

  // trackingType is immutable — reject any attempt to change it.
  if (formData.get('trackingType') !== null) {
    return {
      error: 'trackingType cannot be changed after creation. Deactivate this item and create a new one.',
    }
  }

  // ── Fetch existing document ────────────────────────────────────────────────
  const equipmentRef = adminDb.doc(`companies/${companyId}/equipment/${equipmentId}`)
  const equipmentSnap = await equipmentRef.get()

  if (!equipmentSnap.exists) {
    return { error: 'Equipment not found.' }
  }

  const existingData = equipmentSnap.data() as EquipmentDocumentInternal

  // ── Build partial update payload ───────────────────────────────────────────
  const updates: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  }

  const rawName = formData.get('name') as string | null
  if (rawName !== null) {
    const name = rawName.trim()
    if (name.length === 0) return { error: 'name must be a non-empty string.' }
    if (name.length > 100) return { error: 'name must be 100 characters or fewer.' }
    updates['name'] = name
  }

  const rawDescription = formData.get('description') as string | null
  if (rawDescription !== null) {
    updates['description'] = rawDescription.trim() || null
  }

  const rawCategory = formData.get('category') as string | null
  if (rawCategory !== null) {
    const category = rawCategory.trim()
    if (category.length === 0) return { error: 'category must be a non-empty string.' }
    updates['category'] = category
  }

  // The panel's ACTIVE/INACTIVE toggle. Kept on the same partial-update pattern so
  // callers that don't send it leave the flag alone; toggleEquipmentAvailability
  // remains available for callers that only want to flip this one field.
  const rawAvailableForBooking = formData.get('availableForBooking') as string | null
  if (rawAvailableForBooking !== null) {
    updates['availableForBooking'] = rawAvailableForBooking === 'true'
  }

  const rawRequiresApproval = formData.get('requiresApproval')
  if (rawRequiresApproval !== null) {
    updates['requiresApproval'] = rawRequiresApproval === 'true'
  }

  const rawApproverId = formData.get('approverId') as string | null
  if (rawApproverId !== null) {
    updates['approverId'] = rawApproverId.trim() || null
  }

  const rawCustomFields = formData.get('customFields') as string | null
  if (rawCustomFields !== null) {
    updates['customFields'] = JSON.parse(rawCustomFields)
  }

  // Set only for a quantity-tracked item whose totalQuantity is being written;
  // that write moves the plan-limit counter, so it goes through a transaction.
  let newTotalQuantity: number | null = null

  const rawTotalQuantity = formData.get('totalQuantity')
  if (rawTotalQuantity !== null) {
    if (
      existingData.trackingType !== undefined &&
      existingData.trackingType !== 'quantity'
    ) {
      return { error: 'totalQuantity can only be updated on quantity-tracked items.' }
    }
    if (existingData.trackingType !== undefined) {
      const qty = parseInt(rawTotalQuantity as string, 10)
      if (!Number.isInteger(qty) || qty < 1) {
        return { error: 'totalQuantity must be a positive integer.' }
      }
      updates['totalQuantity'] = qty
      newTotalQuantity = qty
    }
  }

  try {
    if (newTotalQuantity === null) {
      await equipmentRef.update(updates)
    } else {
      const qty = newTotalQuantity
      await adminDb.runTransaction(async (tx) => {
        // Re-read inside the transaction: the pre-read above is only a fast
        // validation path, and a concurrent deactivate or quantity change must
        // not leave the counter applying a stale delta.
        const snap = await tx.get(equipmentRef)
        if (!snap.exists) {
          throw Object.assign(new Error('Equipment not found.'), { code: 'not-found' })
        }
        const current = snap.data() as EquipmentDocumentInternal

        // Only a quantity-tracked, active item occupies `totalQuantity` slots.
        // An inactive one counts 0 either way, so its quantity can change freely.
        const delta =
          isQuantityTracked(current) && current.active
            ? qty - (current.totalQuantity ?? 0)
            : 0

        // Reads company + counter — ALL reads must come before writes.
        if (delta > 0) await assertEquipmentCapacity(tx, companyId, delta)

        tx.update(equipmentRef, updates)
        equipmentCountDelta(tx, companyId, delta)
      })
    }

    revalidatePath('/equipment')
    revalidatePath('/settings/equipment')
    revalidatePath('/bookings')
    revalidatePath('/bookings/new')

    return {}
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'not-found') return { error: 'Equipment not found.' }
    const message = err instanceof Error ? err.message : 'Failed to update equipment'
    console.error('[actions/equipment] updateEquipment failed', { message })
    return { error: message }
  }
}

// ── deactivateEquipment ──────────────────────────────────────────────────────

export async function deactivateEquipment(
  equipmentId: string,
  force = false,
): Promise<
  | { success: true }
  | { requiresForce: true; affectedBookingCount: number }
  | { error: string }
> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  const companyId = session.activeCompanyId

  if (!equipmentId?.trim()) return { error: 'equipmentId is required' }

  // ── Active/upcoming booking check ──────────────────────────────────────────
  // Query by equipmentIds array-contains + endDate range; filter by status in memory.
  // (Firestore does not support array-contains combined with 'in' in one query.)
  // This check runs outside the transaction — it's a UX guard, not a security
  // boundary, so the TOCTOU window here is acceptable.
  // 'ready' has never been a booking status — see types/booking.ts. Guarding on
  // it meant every confirmed booking slipped through and equipment that was
  // booked for next week deleted without a word.
  const ACTIVE_STATUSES = new Set(['pending', 'confirmed', 'checked_out'])
  const todayStr = new Date().toISOString().slice(0, 10)

  const bookingsSnap = await adminDb
    .collection(`companies/${companyId}/bookings`)
    .where('equipmentIds', 'array-contains', equipmentId)
    .where('endDate', '>=', todayStr)
    .get()

  const activeBookings = bookingsSnap.docs.filter((doc) => {
    const data = doc.data()
    return ACTIVE_STATUSES.has(data.status as string)
  })

  if (activeBookings.length > 0 && !force) {
    return {
      requiresForce: true,
      affectedBookingCount: activeBookings.length,
    }
  }

  try {
    const equipmentRef = adminDb.doc(`companies/${companyId}/equipment/${equipmentId}`)
    const counterRef = adminDb.doc(`companies/${companyId}/_meta/equipmentCount`)

    let trackingType: string | undefined

    await adminDb.runTransaction(async (tx) => {
      // ── Read phase (all reads before any writes) ─────────────────────────────
      const equipmentSnap = await tx.get(equipmentRef)

      if (!equipmentSnap.exists) {
        throw Object.assign(new Error('Equipment not found.'), { code: 'not-found' })
      }

      const existingData = equipmentSnap.data() as EquipmentDocumentInternal
      trackingType = existingData.trackingType
      const wasActive = existingData.active

      const counterSnap = await tx.get(counterRef)

      if (!counterSnap.exists) {
        throw new Error('Equipment counter not initialized. Run the backfill migration first.')
      }

      // What this type contributes to the counter right now: its active units, or
      // its totalQuantity. Read inside the transaction so a unit created or
      // deactivated concurrently (both of which read this equipment doc) forces a
      // retry instead of leaving the counter off by one. An already-inactive type
      // contributes 0, so there is nothing to read or subtract.
      let removed = 0
      if (wasActive) {
        if (isQuantityTracked(existingData)) {
          removed = existingData.totalQuantity ?? 0
        } else {
          const activeUnits = await tx.get(equipmentRef.collection('units').where('active', '==', true))
          removed = activeUnits.size
        }
      }

      // ── Write phase ──────────────────────────────────────────────────────────
      tx.update(equipmentRef, { active: false, deactivatedAt: FieldValue.serverTimestamp() })

      // Decrement only when the equipment was truly active; a repeat call on an
      // already-inactive type is a no-op (idempotency guard).
      if (wasActive) {
        equipmentCountDelta(tx, companyId, -removed)
      }
    })

    // Units are deactivated in a separate batch after the transaction. If this batch fails,
    // the parent equipment is already deactivated and the counter is correct (units under an
    // inactive type count 0 regardless), but child units remain active=true. A cleanup job or
    // retry is needed in that case. Legacy types without a trackingType are units types too.
    if (trackingType !== 'quantity') {
      const unitsSnap = await equipmentRef.collection('units').where('active', '==', true).get()
      if (unitsSnap.size > 0) {
        const batch = adminDb.batch()
        for (const unitDoc of unitsSnap.docs) {
          batch.update(unitDoc.ref, { active: false, deactivatedAt: FieldValue.serverTimestamp() })
        }
        await batch.commit()
      }
    }

    revalidatePath('/equipment')
    revalidatePath('/settings/equipment')

    return { success: true }
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'not-found') {
      return { error: 'Equipment not found.' }
    }
    const message = err instanceof Error ? err.message : 'Failed to deactivate equipment'
    console.error('[actions/equipment] deactivateEquipment failed', { message })
    return { error: message }
  }
}

// ── toggleEquipmentAvailability ──────────────────────────────────────────────

export async function toggleEquipmentAvailability(
  equipmentId: string,
  available: boolean,
): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  const companyId = session.activeCompanyId

  if (!equipmentId?.trim()) return { error: 'equipmentId is required' }

  const equipmentRef = adminDb.doc(`companies/${companyId}/equipment/${equipmentId}`)
  const equipmentSnap = await equipmentRef.get()
  if (!equipmentSnap.exists) return { error: 'Equipment not found.' }

  try {
    await equipmentRef.update({ availableForBooking: available, updatedAt: FieldValue.serverTimestamp() })

    revalidatePath('/equipment')
    revalidatePath('/bookings')
    revalidatePath('/bookings/new')

    return {}
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update equipment availability'
    console.error('[actions/equipment] toggleEquipmentAvailability failed', { message })
    return { error: message }
  }
}

// ── toggleUnitAvailability ───────────────────────────────────────────────────

export async function toggleUnitAvailability(
  equipmentId: string,
  unitId: string,
  available: boolean,
): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  if (!equipmentId?.trim()) return { error: 'equipmentId is required' }
  if (!unitId?.trim()) return { error: 'unitId is required' }

  const companyId = session.activeCompanyId
  const path = `companies/${companyId}/equipment/${equipmentId}/units/${unitId}`
  const unitRef = adminDb.doc(path)

  try {
    const snap = await unitRef.get()
    if (!snap.exists) return { error: 'Unit not found.' }

    await unitRef.update({
      availableForBooking: available,
      updatedAt: FieldValue.serverTimestamp(),
    })

    revalidatePath('/equipment')
    revalidatePath('/bookings')
    revalidatePath('/bookings/new')

    return {}
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// ── createUnit ───────────────────────────────────────────────────────────────

export async function createUnit(
  equipmentId: string,
  formData: FormData,
): Promise<{ id: string } | { error: string }> {
  const session = await getVerifiedSession()
  if (!session || session.role !== 'admin') return { error: 'Unauthorized' }

  const companyId = session.activeCompanyId
  const parentRef = adminDb.doc(`companies/${companyId}/equipment/${equipmentId}`)
  const label = (formData.get('label') as string | null)?.trim() ?? ''
  if (!label) return { error: 'Label is required.' }
  if (label.length > 100) return { error: 'Label must be 100 characters or fewer.' }

  const serialNumber = (formData.get('serialNumber') as string | null)?.trim() || null
  const notes = (formData.get('notes') as string | null)?.trim() || null

  // The panel's three-way status control writes both fields: BROKEN sets
  // needs_repair, INACTIVE sets availableForBooking false. Absent fields keep the
  // previous defaults (serviceable, bookable).
  const statusRaw = formData.get('status') as string | null
  const status: EquipmentStatus = VALID_UNIT_STATUSES.includes(statusRaw as EquipmentStatus)
    ? (statusRaw as EquipmentStatus)
    : 'ok'

  const availableRaw = formData.get('availableForBooking') as string | null
  const availableForBooking = availableRaw === null ? true : availableRaw === 'true'

  const unitRef = parentRef.collection('units').doc()

  try {
    await adminDb.runTransaction(async (tx) => {
      // The parent is read inside the transaction so a concurrent deactivation
      // (which writes it) forces a retry — otherwise this unit could be counted
      // under a type that deactivateEquipment has just zeroed out.
      const parentSnap = await tx.get(parentRef)
      if (!parentSnap.exists) {
        throw Object.assign(new Error('Equipment not found.'), { code: 'not-found' })
      }

      const parent = parentSnap.data() as EquipmentDocumentInternal
      if (isQuantityTracked(parent)) {
        throw Object.assign(new Error('Units can only be added to unit-tracked equipment.'), { code: 'failed-precondition' })
      }
      if (!parent.active) {
        throw Object.assign(new Error('Cannot add units to deactivated equipment.'), { code: 'failed-precondition' })
      }

      // Reads company + counter — ALL reads must come before writes.
      await assertEquipmentCapacity(tx, companyId, 1)

      tx.set(unitRef, {
        equipmentId,
        companyId,
        label,
        serialNumber,
        status,
        notes,
        active: true,
        availableForBooking,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: session.uid,
      })
      equipmentCountDelta(tx, companyId, 1)
    })
  } catch (err) {
    const code = (err as { code?: string }).code
    if (USER_FACING_CODES.includes(code ?? '')) {
      return { error: err instanceof Error ? err.message : 'Failed to add unit.' }
    }
    console.error('[actions/equipment] createUnit failed', { message: err instanceof Error ? err.message : err })
    return { error: 'Failed to add unit. Please try again.' }
  }

  revalidatePath('/equipment')
  return { id: unitRef.id }
}

// ── updateUnit ───────────────────────────────────────────────────────────────

export async function updateUnit(
  equipmentId: string,
  unitId: string,
  formData: FormData,
): Promise<void | { error: string }> {
  const session = await getVerifiedSession()
  if (!session || session.role !== 'admin') return { error: 'Unauthorized' }

  const companyId = session.activeCompanyId
  const unitRef = adminDb.doc(`companies/${companyId}/equipment/${equipmentId}/units/${unitId}`)
  const unitSnap = await unitRef.get()
  if (!unitSnap.exists) return { error: 'Unit not found.' }

  const label = (formData.get('label') as string | null)?.trim() ?? ''
  if (!label) return { error: 'Label is required.' }

  const statusRaw = formData.get('status') as string | null

  const updates: Record<string, unknown> = {
    label,
    serialNumber: (formData.get('serialNumber') as string | null)?.trim() || null,
    status: VALID_UNIT_STATUSES.includes(statusRaw as EquipmentStatus) ? statusRaw : 'ok',
    notes: (formData.get('notes') as string | null)?.trim() || null,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: session.uid,
  }

  // Only written when the caller sends it, so existing callers keep their value.
  const availableRaw = formData.get('availableForBooking') as string | null
  if (availableRaw !== null) {
    updates.availableForBooking = availableRaw === 'true'
  }

  await unitRef.update(updates)

  revalidatePath('/equipment')
  revalidatePath('/bookings')
  revalidatePath('/bookings/new')
}

// ── deactivateUnit ───────────────────────────────────────────────────────────

export async function deactivateUnit(
  equipmentId: string,
  unitId: string,
  force = false,
): Promise<void | { error: string } | { requiresForce: true; futureBookingCount: number }> {
  const session = await getVerifiedSession()
  if (!session || session.role !== 'admin') return { error: 'Unauthorized' }

  const companyId = session.activeCompanyId
  const unitRef = adminDb.doc(`companies/${companyId}/equipment/${equipmentId}/units/${unitId}`)
  const unitSnap = await unitRef.get()
  if (!unitSnap.exists) return { error: 'Unit not found.' }

  if (!force) {
    const todayStr = new Date().toISOString().slice(0, 10)

    const bookingsSnap = await adminDb
      .collection('companies').doc(companyId).collection('bookings')
      .where('unitIds', 'array-contains', unitId)
      .where('endDate', '>=', todayStr)
      .get()

    const futureBookings = bookingsSnap.docs.filter((doc) => {
      const data = doc.data()
      return data.status !== 'cancelled' && data.status !== 'returned'
    })

    if (futureBookings.length > 0) {
      return { requiresForce: true, futureBookingCount: futureBookings.length }
    }
  }

  const parentRef = adminDb.doc(`companies/${companyId}/equipment/${equipmentId}`)
  const counterRef = adminDb.doc(`companies/${companyId}/_meta/equipmentCount`)

  try {
    await adminDb.runTransaction(async (tx) => {
      // ── Read phase (all reads before any writes) ───────────────────────────
      const [txUnitSnap, parentSnap, counterSnap] = await Promise.all([
        tx.get(unitRef),
        tx.get(parentRef),
        tx.get(counterRef),
      ])

      if (!txUnitSnap.exists) {
        throw Object.assign(new Error('Unit not found.'), { code: 'not-found' })
      }

      // A unit that is already inactive has already been subtracted (or never
      // counted); a repeat call must change nothing, or two clicks would take
      // the counter down by two.
      if (txUnitSnap.data()!.active === false) return

      // The unit contributes to the counter only while its type is active. Under
      // an inactive type the counter was already zeroed by deactivateEquipment.
      const parentActive = parentSnap.exists && (parentSnap.data() as EquipmentDocumentInternal).active
      if (parentActive && !counterSnap.exists) {
        throw new Error('Equipment counter not initialized. Run the backfill migration first.')
      }

      // ── Write phase ────────────────────────────────────────────────────────
      tx.update(unitRef, {
        active: false,
        deactivatedAt: FieldValue.serverTimestamp(),
        deactivatedBy: session.uid,
      })
      if (parentActive) equipmentCountDelta(tx, companyId, -1)
    })
  } catch (err) {
    if ((err as { code?: string }).code === 'not-found') return { error: 'Unit not found.' }
    const message = err instanceof Error ? err.message : 'Failed to deactivate unit'
    console.error('[actions/equipment] deactivateUnit failed', { message })
    return { error: message }
  }

  revalidatePath('/equipment')
}

// ── updateEquipmentWithUnits ─────────────────────────────────────────────────
// Saves equipment basic fields + all unit changes (updates, creates, deletes) in
// a single Firestore transaction, so the plan-limit counter moves with the units.

const VALID_UNIT_STATUSES: EquipmentStatus[] = ['ok', 'needs_repair']

export interface UnitUpdate {
  id: string
  label: string
  serialNumber: string | null
  status: EquipmentStatus
  notes: string | null
  availableForBooking: boolean
}

export interface UnitCreate {
  label: string
  serialNumber: string | null
  status: EquipmentStatus
  notes: string | null
  availableForBooking: boolean
}

export interface EquipmentFields {
  name: string
  category: string
  description: string | null
  requiresApproval: boolean
  approverId: string | null
  availableForBooking?: boolean
  customFields: CustomField[]
}

export async function updateEquipmentWithUnits(
  equipmentId: string,
  equipment: EquipmentFields,
  unitUpdates: UnitUpdate[],
  unitCreates: UnitCreate[],
  deletedUnitIds: string[],
): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  // ── Validate inputs ────────────────────────────────────────────────────────
  if (!equipmentId?.trim() || equipmentId.includes('/')) {
    return { error: 'equipmentId is required' }
  }

  const name = equipment.name?.trim() ?? ''
  if (!name) return { error: 'name is required' }
  if (name.length > 100) return { error: 'Name must be 100 characters or fewer' }

  const category = equipment.category?.trim() ?? ''
  if (!category) return { error: 'category is required' }

  // Guard against the Firestore 500-write transaction limit: the equipment doc,
  // each unit write, and the counter + stats-mirror writes of the count delta.
  const totalOps = 3 + unitUpdates.length + unitCreates.length + deletedUnitIds.length
  if (totalOps > 500) return { error: 'Too many changes in one request' }

  for (const u of unitUpdates) {
    if (!u.id?.trim() || u.id.includes('/')) return { error: 'Invalid unit id' }
    if (!u.label?.trim()) return { error: 'Unit label is required' }
    if (!VALID_UNIT_STATUSES.includes(u.status)) {
      return { error: `Invalid unit status: "${u.status}"` }
    }
  }

  for (const u of unitCreates) {
    if (!u.label?.trim()) return { error: 'Unit label is required' }
    if (!VALID_UNIT_STATUSES.includes(u.status)) {
      return { error: `Invalid unit status: "${u.status}"` }
    }
  }

  for (const unitId of deletedUnitIds) {
    if (!unitId?.trim() || unitId.includes('/')) return { error: 'Invalid unit id' }
  }

  const companyId = session.activeCompanyId

  try {
    const equipRef = adminDb.doc(`companies/${companyId}/equipment/${equipmentId}`)
    const unitRefFor = (unitId: string) =>
      adminDb.doc(`companies/${companyId}/equipment/${equipmentId}/units/${unitId}`)
    const uniqueDeletedIds = [...new Set(deletedUnitIds)]

    await adminDb.runTransaction(async (tx) => {
      // ── Read phase (all reads before any writes) ─────────────────────────────
      const equipSnap = await tx.get(equipRef)
      if (!equipSnap.exists || !equipSnap.data()?.active) {
        throw Object.assign(new Error('Equipment not found'), { code: 'not-found' })
      }
      if ((unitCreates.length > 0 || uniqueDeletedIds.length > 0) && isQuantityTracked(equipSnap.data() as EquipmentDocumentInternal)) {
        throw Object.assign(new Error('Units can only be changed on unit-tracked equipment.'), { code: 'failed-precondition' })
      }

      // Only deletions of units that are still active lower the counter; a unit
      // that is already inactive was subtracted when it was deactivated.
      const deletedSnaps = await Promise.all(uniqueDeletedIds.map((id) => tx.get(unitRefFor(id))))
      const deactivating = deletedSnaps.filter((snap) => snap.exists && snap.data()?.active !== false).length

      const delta = unitCreates.length - deactivating

      if (delta > 0) await assertEquipmentCapacity(tx, companyId, delta)

      // ── Write phase ──────────────────────────────────────────────────────────
      // Update equipment basic fields
      tx.update(equipRef, {
        name,
        category,
        description: equipment.description?.trim() || null,
        requiresApproval: equipment.requiresApproval,
        approverId: equipment.approverId || null,
        ...(equipment.availableForBooking !== undefined && { availableForBooking: equipment.availableForBooking }),
        customFields: equipment.customFields,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: session.uid,
      })

      // Update existing units
      for (const u of unitUpdates) {
        tx.update(unitRefFor(u.id), {
          label: u.label,
          serialNumber: u.serialNumber,
          status: u.status,
          notes: u.notes,
          availableForBooking: u.availableForBooking,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: session.uid,
        })
      }

      // Create new units
      const unitsCollection = adminDb
        .collection(`companies/${companyId}/equipment/${equipmentId}/units`)
      for (const u of unitCreates) {
        tx.set(unitsCollection.doc(), {
          equipmentId,
          companyId,
          label: u.label,
          serialNumber: u.serialNumber,
          status: u.status,
          notes: u.notes,
          active: true,
          availableForBooking: u.availableForBooking,
          createdAt: FieldValue.serverTimestamp(),
          createdBy: session.uid,
        })
      }

      // Deactivate deleted units (already-inactive ones are left untouched)
      uniqueDeletedIds.forEach((id, i) => {
        if (!deletedSnaps[i].exists || deletedSnaps[i].data()?.active === false) return
        tx.update(unitRefFor(id), {
          active: false,
          deactivatedAt: FieldValue.serverTimestamp(),
          deactivatedBy: session.uid,
        })
      })

      equipmentCountDelta(tx, companyId, delta)
    })

    revalidatePath('/equipment')
    revalidatePath('/bookings')
    revalidatePath('/bookings/new')

    return {}
  } catch (err) {
    const code = (err as { code?: string }).code
    if (USER_FACING_CODES.includes(code ?? '')) {
      return { error: err instanceof Error ? err.message : 'Failed to save changes.' }
    }
    console.error('[updateEquipmentWithUnits]', err)
    return { error: 'Failed to save changes. Please try again.' }
  }
}

// ── createEquipmentWithUnits ─────────────────────────────────────────────────
// Creates an equipment document and its initial unit subcollection docs in one
// transaction, so the plan-limit check, the counter and every unit land together.

export async function createEquipmentWithUnits(
  fields: {
    name: string
    description: string | null
    category: string
    trackingType: TrackingType
    totalQuantity: number
    requiresApproval: boolean
    approverId: string | null
    customFields: CustomField[]
  },
  unitCreates: UnitCreate[],
): Promise<{ id: string } | { error: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  const companyId = session.activeCompanyId

  // ── Input validation ─────────────────────────────────────────────────────────
  const name = fields.name?.trim() ?? ''
  if (!name) return { error: 'Name is required' }
  if (name.length > 100) return { error: 'Name must be 100 characters or fewer' }

  const category = fields.category?.trim() ?? ''
  if (!category) return { error: 'Category is required' }

  if (fields.trackingType === 'quantity') {
    const qty = fields.totalQuantity
    if (!Number.isInteger(qty) || qty < 1) {
      return { error: 'totalQuantity must be a positive integer for quantity items' }
    }
  }

  for (const u of unitCreates) {
    if (!u.label?.trim()) return { error: 'Unit label is required' }
    if (!VALID_UNIT_STATUSES.includes(u.status)) {
      return { error: `Invalid unit status: "${u.status}"` }
    }
  }

  // Guard against the Firestore 500-write transaction limit: the equipment doc,
  // the unit creates, and the counter + stats-mirror writes of the count delta.
  if (unitCreates.length > 497) return { error: 'Too many units in one request' }

  // ── Transaction: check plan limit + write equipment and units atomically ─────
  let newEquipmentId: string

  try {
    await adminDb.runTransaction(async (tx) => {
      // A quantity type occupies its totalQuantity; a units type occupies one
      // slot per unit. Units submitted for a quantity type are not counted.
      const adding = fields.trackingType === 'quantity' ? fields.totalQuantity : unitCreates.length

      // Reads company + counter — ALL reads must come before writes.
      await assertEquipmentCapacity(tx, companyId, adding)

      const newRef = adminDb.collection(`companies/${companyId}/equipment`).doc()
      newEquipmentId = newRef.id

      // Increment counter atomically with the equipment write.
      equipmentCountDelta(tx, companyId, adding)

      tx.set(newRef, {
        name,
        description: fields.description?.trim() || null,
        category,
        trackingType: fields.trackingType,
        totalQuantity: fields.totalQuantity,
        active: true,
        requiresApproval: fields.requiresApproval,
        approverId: fields.approverId || null,
        customFields: fields.customFields,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: session.uid,
      })

      const unitsCollection = adminDb.collection(
        `companies/${companyId}/equipment/${newRef.id}/units`,
      )
      for (const u of unitCreates) {
        tx.set(unitsCollection.doc(), {
          equipmentId: newRef.id,
          companyId,
          label: u.label,
          serialNumber: u.serialNumber,
          status: u.status,
          notes: u.notes,
          active: true,
          availableForBooking: u.availableForBooking,
          createdAt: FieldValue.serverTimestamp(),
          createdBy: session.uid,
        })
      }
    })

    revalidatePath('/equipment')
    revalidatePath('/settings/equipment')

    return { id: newEquipmentId! }
  } catch (err) {
    const code = (err as { code?: string }).code
    const isUserFacing = USER_FACING_CODES.includes(code ?? '')
    const userMessage = isUserFacing
      ? (err instanceof Error ? err.message : 'Unexpected error')
      : 'Failed to create equipment. Please try again.'
    console.error('[actions/equipment] createEquipmentWithUnits failed', { message: err instanceof Error ? err.message : err })
    return { error: userMessage }
  }
}
