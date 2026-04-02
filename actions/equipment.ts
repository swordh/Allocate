'use server'

import { FieldValue } from 'firebase-admin/firestore'
import { revalidatePath } from 'next/cache'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import type { Subscription, EquipmentStatus } from '@/types'

// ── Internal Firestore document shapes ──────────────────────────────────────

interface CompanyDocumentInternal {
  subscription: Subscription
}

interface EquipmentDocumentInternal {
  trackingType?: string
  active: boolean
  name: string
}

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
    (formData.get('trackingType') as string | null) === 'quantity' ? 'quantity' : 'serialized'

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
      const companyRef = adminDb.doc(`companies/${companyId}`)
      const companySnap = await tx.get(companyRef)

      if (!companySnap.exists) {
        throw Object.assign(new Error('Company not found.'), { code: 'not-found' })
      }

      const company = companySnap.data() as CompanyDocumentInternal
      const { subscription } = company

      if (subscription.status !== 'trialing' && subscription.status !== 'active') {
        throw Object.assign(
          new Error('Subscription is not active. Reactivate your plan to add equipment.'),
          { code: 'failed-precondition' },
        )
      }

      // Count active equipment. Aggregation queries cannot run inside
      // runTransaction, so we query outside and accept the negligible TOCTOU
      // window — this is a soft cap, not a security boundary.
      const countSnap = await adminDb
        .collection(`companies/${companyId}/equipment`)
        .where('active', '==', true)
        .count()
        .get()
      const currentCount = countSnap.data().count

      const limit = subscription.limits.equipment
      const plan = subscription.plan

      if (currentCount >= limit) {
        throw Object.assign(
          new Error(
            `Equipment limit reached. Your ${plan} plan allows ${limit} items. Upgrade to add more.`,
          ),
          { code: 'resource-exhausted' },
        )
      }

      const newRef = adminDb.collection(`companies/${companyId}/equipment`).doc()
      newEquipmentId = newRef.id

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
    }
  }

  try {
    await equipmentRef.update(updates)

    revalidatePath('/equipment')
    revalidatePath('/settings/equipment')

    return {}
  } catch (err) {
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

  const equipmentRef = adminDb.doc(`companies/${companyId}/equipment/${equipmentId}`)
  const equipmentSnap = await equipmentRef.get()

  if (!equipmentSnap.exists) {
    return { error: 'Equipment not found.' }
  }

  const existingData = equipmentSnap.data() as EquipmentDocumentInternal

  // ── Active/upcoming booking check ──────────────────────────────────────────
  // Query by equipmentIds array-contains + endDate range; filter by status in memory.
  // (Firestore does not support array-contains combined with 'in' in one query.)
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
    const batch = adminDb.batch()
    batch.update(equipmentRef, { active: false, deactivatedAt: FieldValue.serverTimestamp() })

    if (existingData.trackingType === 'serialized') {
      const unitsSnap = await equipmentRef.collection('units').where('active', '==', true).get()
      for (const unitDoc of unitsSnap.docs) {
        batch.update(unitDoc.ref, { active: false, deactivatedAt: FieldValue.serverTimestamp() })
      }
    }

    await batch.commit()

    revalidatePath('/equipment')
    revalidatePath('/settings/equipment')

    return { success: true }
  } catch (err) {
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
  const parentSnap = await parentRef.get()
  if (!parentSnap.exists) return { error: 'Equipment not found.' }

  const parent = parentSnap.data()!
  if (parent.trackingType !== 'serialized') return { error: 'Units can only be added to serialized equipment.' }
  if (!parent.active) return { error: 'Cannot add units to deactivated equipment.' }

  const label = (formData.get('label') as string | null)?.trim() ?? ''
  if (!label) return { error: 'Label is required.' }
  if (label.length > 100) return { error: 'Label must be 100 characters or fewer.' }

  const serialNumber = (formData.get('serialNumber') as string | null)?.trim() || null
  const notes = (formData.get('notes') as string | null)?.trim() || null

  const unitRef = parentRef.collection('units').doc()
  await unitRef.set({
    equipmentId,
    companyId,
    label,
    serialNumber,
    status: 'available',
    notes,
    active: true,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: session.uid,
  })

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

  const VALID_STATUSES: EquipmentStatus[] = ['available', 'checked_out', 'needs_repair']

  const statusRaw = formData.get('status') as string | null

  await unitRef.update({
    label,
    serialNumber: (formData.get('serialNumber') as string | null)?.trim() || null,
    status: VALID_STATUSES.includes(statusRaw as EquipmentStatus) ? statusRaw : 'available',
    notes: (formData.get('notes') as string | null)?.trim() || null,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: session.uid,
  })

  revalidatePath('/equipment')
}

// ── deactivateUnit ───────────────────────────────────────────────────────────

export async function deactivateUnit(
  equipmentId: string,
  unitId: string,
  force = false,
): Promise<void | { error: string }> {
  const session = await getVerifiedSession()
  if (!session || session.role !== 'admin') return { error: 'Unauthorized' }

  const companyId = session.activeCompanyId
  const unitRef = adminDb.doc(`companies/${companyId}/equipment/${equipmentId}/units/${unitId}`)
  const unitSnap = await unitRef.get()
  if (!unitSnap.exists) return { error: 'Unit not found.' }

  if (!force) {
    const bookingsSnap = await adminDb
      .collection('companies').doc(companyId).collection('bookings')
      .where('unitIds', 'array-contains', unitId)
      .get()

    const activeBookings = bookingsSnap.docs.filter((doc) => {
      const data = doc.data()
      return data.status !== 'cancelled' && data.status !== 'returned'
    })

    if (activeBookings.length > 0) {
      return { error: 'This unit has active bookings. Deactivate or cancel them first.' }
    }
  }

  await unitRef.update({
    active: false,
    deactivatedAt: FieldValue.serverTimestamp(),
    deactivatedBy: session.uid,
  })

  revalidatePath('/equipment')
}
