'use server'

import { FieldValue } from 'firebase-admin/firestore'
import { revalidatePath } from 'next/cache'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import type { Subscription } from '@/types'

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

  const VALID_STATUSES = ['available', 'checked_out', 'needs_repair'] as const
  type EquipmentStatus = (typeof VALID_STATUSES)[number]

  const rawStatus = formData.get('status') as string | null
  let status: EquipmentStatus = 'available'
  if (rawStatus !== null && rawStatus !== undefined) {
    if (!VALID_STATUSES.includes(rawStatus as EquipmentStatus)) {
      return { error: `status must be one of: ${VALID_STATUSES.join(', ')}` }
    }
    status = rawStatus as EquipmentStatus
  }

  const trackingType =
    (formData.get('trackingType') as string | null) === 'quantity' ? 'quantity' : 'individual'

  let totalQuantity = 1
  if (trackingType === 'quantity') {
    const raw = parseInt(formData.get('totalQuantity') as string ?? '0', 10)
    if (!Number.isInteger(raw) || raw < 1) {
      return { error: 'totalQuantity must be a positive integer for quantity items' }
    }
    totalQuantity = raw
  }

  const serialNumberRaw = formData.get('serialNumber') as string | null
  if (trackingType === 'quantity' && serialNumberRaw !== null && serialNumberRaw !== '') {
    return { error: 'serialNumber is not allowed for quantity-tracked items' }
  }
  const serialNumber: string | null =
    trackingType === 'individual' ? (serialNumberRaw?.trim() || null) : null

  const requiresApproval = formData.get('requiresApproval') === 'true'
  const approverIdRaw = formData.get('approverId') as string | null
  const approverId: string | null = approverIdRaw?.trim() || null

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
        category,
        trackingType,
        totalQuantity,
        serialNumber,
        status,
        active: true,
        requiresApproval,
        approverId,
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
  const VALID_STATUSES = ['available', 'checked_out', 'needs_repair'] as const
  type EquipmentStatus = (typeof VALID_STATUSES)[number]

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

  const rawCategory = formData.get('category') as string | null
  if (rawCategory !== null) {
    const category = rawCategory.trim()
    if (category.length === 0) return { error: 'category must be a non-empty string.' }
    updates['category'] = category
  }

  const rawStatus = formData.get('status') as string | null
  if (rawStatus !== null) {
    if (!VALID_STATUSES.includes(rawStatus as EquipmentStatus)) {
      return { error: `status must be one of: ${VALID_STATUSES.join(', ')}.` }
    }
    updates['status'] = rawStatus as EquipmentStatus
  }

  const rawRequiresApproval = formData.get('requiresApproval')
  if (rawRequiresApproval !== null) {
    updates['requiresApproval'] = rawRequiresApproval === 'true'
  }

  const rawApproverId = formData.get('approverId') as string | null
  if (rawApproverId !== null) {
    updates['approverId'] = rawApproverId.trim() || null
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

  const rawSerialNumber = formData.get('serialNumber')
  if (rawSerialNumber !== null) {
    if (
      existingData.trackingType !== undefined &&
      existingData.trackingType !== 'individual'
    ) {
      return { error: 'serialNumber is not allowed on quantity-tracked items.' }
    }
    if (existingData.trackingType !== undefined) {
      updates['serialNumber'] =
        rawSerialNumber ? (rawSerialNumber as string).trim() || null : null
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
    await equipmentRef.update({
      active: false,
      deactivatedAt: FieldValue.serverTimestamp(),
    })

    revalidatePath('/equipment')
    revalidatePath('/settings/equipment')

    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to deactivate equipment'
    console.error('[actions/equipment] deactivateEquipment failed', { message })
    return { error: message }
  }
}
