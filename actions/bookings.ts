'use server'

import { FieldValue } from 'firebase-admin/firestore'
import type { Firestore, Transaction } from 'firebase-admin/firestore'
import { revalidatePath } from 'next/cache'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import type { BookingItem, Subscription } from '@/types'

// ── Internal Firestore document shapes ──────────────────────────────────────

interface CompanyDocumentInternal {
  subscription: Subscription
}

interface EquipmentDocumentInternal {
  name: string
  active: boolean
  trackingType: 'serialized' | 'quantity'
  totalQuantity: number
  requiresApproval: boolean
  approverId: string | null
}

interface BookingDocumentInternal {
  projectName: string
  notes: string
  items: BookingItem[]
  equipmentIds: string[]
  startDate: string
  endDate: string
  userId: string | null
  status: string
  requiresApproval: boolean
  approverId: string | null
  approvalStatus: string
  rejectionReason: string | null
  cancelledAt: null
  cancelledBy: null
}

// ── Conflict detection (inlined from Cloud Functions business logic) ──────────
// These helpers mirror functions/src/bookings/conflictDetection.ts exactly.
// They cannot be imported from there because functions/ is a separate package.

interface ConflictDetailInternal {
  equipmentId: string
  equipmentName: string
  reason: 'already_booked' | 'insufficient_quantity'
  requested?: number
  available?: number
  conflictingBookingId?: string
}

interface ConflictResultInternal {
  hasConflict: boolean
  conflicts: ConflictDetailInternal[]
}

interface StoredBookingForConflict {
  startDate: string
  endDate: string
  status: string
  approvalStatus: string
  items: BookingItem[]
  equipmentIds: string[]
}

/**
 * Validate items array. Throws a plain Error on failure.
 */
function validateItems(rawItems: unknown): BookingItem[] {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error('items must be a non-empty array.')
  }
  if (rawItems.length > 50) {
    throw new Error('items may not exceed 50 entries.')
  }
  return rawItems.map((entry: unknown, idx: number) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`items[${idx}]: each entry must be an object.`)
    }
    const { equipmentId, quantity, unitId } = entry as Record<string, unknown>
    if (typeof equipmentId !== 'string' || equipmentId.trim().length === 0) {
      throw new Error(`items[${idx}].equipmentId is required.`)
    }
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
      throw new Error(`items[${idx}].quantity must be a positive integer.`)
    }
    return {
      equipmentId: equipmentId.trim(),
      quantity,
      ...(unitId ? { unitId: String(unitId).trim() } : {}),
    }
  })
}

/**
 * Validate a YYYY-MM-DD date string. Throws a plain Error on failure.
 */
function validateDateString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${fieldName} must be a date string in YYYY-MM-DD format.`)
  }
  return value
}

/**
 * Extract a flat array of equipment IDs from an items array.
 */
function extractEquipmentIds(items: BookingItem[]): string[] {
  return items.map((i) => i.equipmentId)
}

/**
 * Read-only conflict detection — used by the checkConflict pre-check.
 * Advisory only; write paths use detectConflictsInTransaction.
 */
async function detectConflictsReadOnly(
  db: Firestore,
  companyId: string,
  requestedItems: BookingItem[],
  startDate: string,
  endDate: string,
  excludeBookingId?: string,
): Promise<ConflictResultInternal> {
  const conflicts: ConflictDetailInternal[] = []
  const bookingsRef = db.collection(`companies/${companyId}/bookings`)

  for (const item of requestedItems) {
    const equipmentSnap = await db
      .doc(`companies/${companyId}/equipment/${item.equipmentId}`)
      .get()

    if (!equipmentSnap.exists) {
      conflicts.push({
        equipmentId: item.equipmentId,
        equipmentName: 'Unknown',
        reason: 'already_booked',
      })
      continue
    }

    const equipment = equipmentSnap.data() as EquipmentDocumentInternal

    if (equipment.trackingType === 'serialized') {
      // For serialized items, conflict is per-unit, not per-equipment-type.
      if (!item.unitId) {
        conflicts.push({
          equipmentId: item.equipmentId,
          equipmentName: equipment.name,
          reason: 'already_booked',
        })
        continue
      }

      // Verify the unit exists and is active.
      const unitSnap = await db
        .doc(`companies/${companyId}/equipment/${item.equipmentId}/units/${item.unitId}`)
        .get()
      if (!unitSnap.exists || unitSnap.data()?.active === false) {
        conflicts.push({
          equipmentId: item.equipmentId,
          equipmentName: equipment.name,
          reason: 'already_booked',
        })
        continue
      }

      // Query: bookings referencing this specific unit whose endDate >= our startDate.
      const unitQuery = await bookingsRef
        .where('unitIds', 'array-contains', item.unitId)
        .where('endDate', '>=', startDate)
        .get()

      const overlapping = unitQuery.docs.filter((doc) => {
        if (doc.id === excludeBookingId) return false
        const data = doc.data() as StoredBookingForConflict
        if (data.status === 'cancelled') return false
        if (data.approvalStatus === 'rejected') return false
        return data.startDate <= endDate
      })

      if (overlapping.length > 0) {
        conflicts.push({
          equipmentId: item.equipmentId,
          equipmentName: equipment.name,
          reason: 'already_booked',
          conflictingBookingId: overlapping[0].id,
        })
      }
    } else {
      // Quantity items: check aggregate availability.
      // Query: bookings referencing this equipment whose endDate >= our startDate.
      // booking.startDate <= requestedEndDate is checked in memory.
      const eqQuery = await bookingsRef
        .where('equipmentIds', 'array-contains', item.equipmentId)
        .where('endDate', '>=', startDate)
        .get()

      const overlapping = eqQuery.docs.filter((doc) => {
        if (doc.id === excludeBookingId) return false
        const data = doc.data() as StoredBookingForConflict
        if (data.status === 'cancelled') return false
        if (data.approvalStatus === 'rejected') return false
        return data.startDate <= endDate
      })

      let sumBooked = 0
      for (const doc of overlapping) {
        const data = doc.data() as StoredBookingForConflict
        const matchingItem = data.items.find((i) => i.equipmentId === item.equipmentId)
        if (matchingItem) sumBooked += matchingItem.quantity
      }
      const available = equipment.totalQuantity - sumBooked
      if (item.quantity > available) {
        conflicts.push({
          equipmentId: item.equipmentId,
          equipmentName: equipment.name,
          reason: 'insufficient_quantity',
          requested: item.quantity,
          available: Math.max(0, available),
          conflictingBookingId: overlapping.length > 0 ? overlapping[0].id : undefined,
        })
      }
    }
  }

  return { hasConflict: conflicts.length > 0, conflicts }
}

/**
 * Conflict detection inside a Firestore transaction — authoritative.
 * Used by createBooking, updateBooking, approveBooking.
 */
async function detectConflictsInTransaction(
  tx: Transaction,
  db: Firestore,
  companyId: string,
  requestedItems: BookingItem[],
  startDate: string,
  endDate: string,
  excludeBookingId?: string,
): Promise<ConflictResultInternal> {
  const conflicts: ConflictDetailInternal[] = []
  const bookingsRef = db.collection(`companies/${companyId}/bookings`)

  for (const item of requestedItems) {
    const equipmentRef = db.doc(`companies/${companyId}/equipment/${item.equipmentId}`)
    const equipmentSnap = await tx.get(equipmentRef)

    if (!equipmentSnap.exists) {
      conflicts.push({
        equipmentId: item.equipmentId,
        equipmentName: 'Unknown',
        reason: 'already_booked',
      })
      continue
    }

    const equipment = equipmentSnap.data() as EquipmentDocumentInternal

    if (equipment.trackingType === 'serialized') {
      // For serialized items, conflict is per-unit, not per-equipment-type.
      if (!item.unitId) {
        conflicts.push({
          equipmentId: item.equipmentId,
          equipmentName: equipment.name,
          reason: 'already_booked',
        })
        continue
      }

      // Verify the unit exists and is active.
      const unitRef = db.doc(`companies/${companyId}/equipment/${item.equipmentId}/units/${item.unitId}`)
      const unitSnap = await tx.get(unitRef)
      if (!unitSnap.exists || unitSnap.data()?.active === false) {
        conflicts.push({
          equipmentId: item.equipmentId,
          equipmentName: equipment.name,
          reason: 'already_booked',
        })
        continue
      }

      const unitQuery = bookingsRef
        .where('unitIds', 'array-contains', item.unitId)
        .where('endDate', '>=', startDate)

      const unitQuerySnap = await tx.get(unitQuery)

      const overlapping = unitQuerySnap.docs.filter((doc) => {
        if (doc.id === excludeBookingId) return false
        const data = doc.data() as StoredBookingForConflict
        if (data.status === 'cancelled') return false
        if (data.approvalStatus === 'rejected') return false
        return data.startDate <= endDate
      })

      if (overlapping.length > 0) {
        conflicts.push({
          equipmentId: item.equipmentId,
          equipmentName: equipment.name,
          reason: 'already_booked',
          conflictingBookingId: overlapping[0].id,
        })
      }
    } else {
      // Quantity items: check aggregate availability.
      const eqQuery = bookingsRef
        .where('equipmentIds', 'array-contains', item.equipmentId)
        .where('endDate', '>=', startDate)

      const querySnap = await tx.get(eqQuery)

      const overlapping = querySnap.docs.filter((doc) => {
        if (doc.id === excludeBookingId) return false
        const data = doc.data() as StoredBookingForConflict
        if (data.status === 'cancelled') return false
        if (data.approvalStatus === 'rejected') return false
        return data.startDate <= endDate
      })

      let sumBooked = 0
      for (const doc of overlapping) {
        const data = doc.data() as StoredBookingForConflict
        const matchingItem = data.items.find((i) => i.equipmentId === item.equipmentId)
        if (matchingItem) sumBooked += matchingItem.quantity
      }
      const available = equipment.totalQuantity - sumBooked
      if (item.quantity > available) {
        conflicts.push({
          equipmentId: item.equipmentId,
          equipmentName: equipment.name,
          reason: 'insufficient_quantity',
          requested: item.quantity,
          available: Math.max(0, available),
          conflictingBookingId: overlapping.length > 0 ? overlapping[0].id : undefined,
        })
      }
    }
  }

  return { hasConflict: conflicts.length > 0, conflicts }
}

// ── Public types re-exported for UI consumers ──────────────────────────────

export interface ConflictItem {
  equipmentId: string
  reason: 'already_booked' | 'insufficient_quantity'
  requested?: number
  available?: number
}

export interface ConflictResult {
  hasConflict: boolean
  conflicts: ConflictItem[]
}

// ── createBooking ────────────────────────────────────────────────────────────

export async function createBooking(
  formData: FormData,
): Promise<{ bookingId: string } | { error: string }> {
  const session = await getVerifiedSession()
  if (session.role === 'viewer') return { error: 'Unauthorized' }

  const companyId = session.activeCompanyId

  // ── Input validation ───────────────────────────────────────────────────────
  const projectName = (formData.get('projectName') as string | null)?.trim() ?? ''
  if (!projectName) return { error: 'Project name is required' }
  if (projectName.length > 200) return { error: 'Project name must be 200 characters or fewer' }

  const rawStartDate = (formData.get('startDate') as string | null)?.trim() ?? ''
  const rawEndDate = (formData.get('endDate') as string | null)?.trim() ?? ''

  let startDate: string
  let endDate: string
  try {
    startDate = validateDateString(rawStartDate, 'startDate')
    endDate = validateDateString(rawEndDate, 'endDate')
  } catch (err) {
    return { error: (err as Error).message }
  }

  if (endDate < startDate) return { error: 'End date must be on or after start date' }

  const todayStr = new Date().toISOString().slice(0, 10)
  if (startDate < todayStr) return { error: 'startDate must be today or a future date.' }

  const notes = (formData.get('notes') as string | null) ?? ''
  if (typeof notes !== 'string') return { error: 'notes must be a string.' }
  if (notes.length > 2000) return { error: 'Notes must be 2000 characters or fewer' }

  const itemsRaw = formData.get('items') as string | null
  let items: BookingItem[] = []
  try {
    items = itemsRaw ? validateItems(JSON.parse(itemsRaw)) : []
  } catch (err) {
    return { error: (err as Error).message ?? 'Invalid equipment selection' }
  }

  if (items.length === 0) return { error: 'At least one equipment item is required' }

  // ── Transaction ────────────────────────────────────────────────────────────
  let newBookingId: string

  try {
    await adminDb.runTransaction(async (tx) => {
      // 1. Verify subscription.
      const companyRef = adminDb.doc(`companies/${companyId}`)
      const companySnap = await tx.get(companyRef)
      if (!companySnap.exists) {
        throw new Error('Company not found.')
      }
      const company = companySnap.data() as CompanyDocumentInternal
      const { status: subStatus } = company.subscription
      if (subStatus !== 'active' && subStatus !== 'trialing') {
        throw new Error('Subscription is not active. Reactivate your plan to create bookings.')
      }

      // 2. Validate each equipment item; collect requiresApproval / approverId.
      let requiresApproval = false
      let approverId: string | null = null

      for (const item of items) {
        const equipRef = adminDb.doc(`companies/${companyId}/equipment/${item.equipmentId}`)
        const equipSnap = await tx.get(equipRef)

        if (!equipSnap.exists) {
          throw new Error(`Equipment ${item.equipmentId} not found.`)
        }

        const equipment = equipSnap.data() as EquipmentDocumentInternal

        if (!equipment.active) {
          throw new Error(`Equipment "${equipment.name}" is not available (deactivated).`)
        }

        if (equipment.trackingType === 'serialized') {
          if (item.quantity !== 1) {
            throw new Error(
              `Equipment "${equipment.name}" is serialized; quantity must be 1.`,
            )
          }
          if (!item.unitId) {
            throw new Error(
              `Equipment "${equipment.name}" is serialized; unitId is required.`,
            )
          }
        }

        if (
          equipment.trackingType === 'quantity' &&
          item.quantity > equipment.totalQuantity
        ) {
          throw new Error(
            `Requested quantity (${item.quantity}) exceeds total stock (${equipment.totalQuantity}) for "${equipment.name}".`,
          )
        }

        if (equipment.requiresApproval) {
          requiresApproval = true
          if (approverId === null && equipment.approverId) {
            approverId = equipment.approverId
          }
        }
      }

      // 3. Conflict detection inside the transaction (prevents TOCTOU races).
      const conflictResult = await detectConflictsInTransaction(
        tx,
        adminDb,
        companyId,
        items,
        startDate,
        endDate,
      )

      if (conflictResult.hasConflict) {
        const names = conflictResult.conflicts.map((c) => c.equipmentName).join(', ')
        throw new Error(`Booking conflict detected for: ${names}.`)
      }

      // 4. Write the booking document.
      const bookingsRef = adminDb.collection(`companies/${companyId}/bookings`)
      const newRef = bookingsRef.doc()
      newBookingId = newRef.id

      const bookingStatus = requiresApproval ? 'pending' : 'confirmed'
      const approvalStatus = requiresApproval ? 'pending' : 'none'
      const equipmentIds = extractEquipmentIds(items)
      const unitIds = items.flatMap((i) => (i.unitId ? [i.unitId] : []))

      tx.set(newRef, {
        projectName,
        notes,
        items,
        equipmentIds,
        unitIds,
        startDate,
        endDate,
        userId: session.uid,
        userName: null,
        status: bookingStatus,
        requiresApproval,
        approverId,
        approvalStatus,
        rejectionReason: null,
        cancelledAt: null,
        cancelledBy: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: null,
      })
    })

    revalidatePath('/bookings')
    return { bookingId: newBookingId! }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create booking'
    console.error('[actions/bookings] createBooking failed', { message })
    return { error: message }
  }
}

// ── updateBooking ────────────────────────────────────────────────────────────

export async function updateBooking(
  bookingId: string,
  formData: FormData,
): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role === 'viewer') return { error: 'Unauthorized' }

  const companyId = session.activeCompanyId

  if (!bookingId?.trim()) return { error: 'bookingId is required' }

  // ── Optional field validation ──────────────────────────────────────────────
  const rawProjectName = formData.get('projectName') as string | null
  let projectName: string | undefined
  if (rawProjectName !== null) {
    const trimmed = rawProjectName.trim()
    if (trimmed.length === 0) return { error: 'Project name is required' }
    if (trimmed.length > 200) return { error: 'Project name must be 200 characters or fewer' }
    projectName = trimmed
  }

  const rawStartDate = formData.get('startDate') as string | null
  let startDate: string | undefined
  if (rawStartDate !== null && rawStartDate.trim() !== '') {
    try {
      startDate = validateDateString(rawStartDate.trim(), 'startDate')
    } catch (err) {
      return { error: (err as Error).message }
    }
  }

  const rawEndDate = formData.get('endDate') as string | null
  let endDate: string | undefined
  if (rawEndDate !== null && rawEndDate.trim() !== '') {
    try {
      endDate = validateDateString(rawEndDate.trim(), 'endDate')
    } catch (err) {
      return { error: (err as Error).message }
    }
  }

  const rawNotes = formData.get('notes') as string | null
  let notes: string | undefined
  if (rawNotes !== null) {
    if (typeof rawNotes !== 'string') return { error: 'notes must be a string.' }
    if (rawNotes.length > 2000) return { error: 'Notes must be 2000 characters or fewer' }
    notes = rawNotes
  }

  const itemsRaw = formData.get('items') as string | null
  let items: BookingItem[] | undefined
  if (itemsRaw) {
    try {
      items = validateItems(JSON.parse(itemsRaw))
    } catch (err) {
      return { error: (err as Error).message ?? 'Invalid equipment selection' }
    }
    if (items.length === 0) return { error: 'At least one equipment item is required' }
  }

  const uid = session.uid
  const isAdmin = session.role === 'admin'

  try {
    await adminDb.runTransaction(async (tx) => {
      const bookingRef = adminDb.doc(`companies/${companyId}/bookings/${bookingId}`)
      const bookingSnap = await tx.get(bookingRef)

      if (!bookingSnap.exists) {
        throw new Error('Booking not found.')
      }

      const booking = bookingSnap.data() as BookingDocumentInternal

      // ── Ownership / role check ─────────────────────────────────────────────
      if (!isAdmin && booking.userId !== uid) {
        throw new Error('You can only edit your own bookings.')
      }

      // ── Status check ──────────────────────────────────────────────────────
      if (booking.status !== 'pending' && booking.status !== 'confirmed') {
        throw new Error(`Cannot edit a booking with status '${booking.status}'.`)
      }

      const effectiveItems = items ?? booking.items
      const effectiveStartDate = startDate ?? booking.startDate
      const effectiveEndDate = endDate ?? booking.endDate

      if (effectiveEndDate < effectiveStartDate) {
        throw new Error('endDate must be on or after startDate.')
      }

      // ── Re-validate equipment if items changed ─────────────────────────────
      let requiresApproval = booking.requiresApproval
      let approverId = booking.approverId

      if (items !== undefined) {
        requiresApproval = false
        approverId = null

        for (const item of items) {
          const equipRef = adminDb.doc(`companies/${companyId}/equipment/${item.equipmentId}`)
          const equipSnap = await tx.get(equipRef)

          if (!equipSnap.exists) {
            throw new Error(`Equipment ${item.equipmentId} not found.`)
          }

          const equipment = equipSnap.data() as EquipmentDocumentInternal

          if (!equipment.active) {
            throw new Error(`Equipment "${equipment.name}" is not available (deactivated).`)
          }

          if (equipment.trackingType === 'serialized' && item.quantity !== 1) {
            throw new Error(
              `Equipment "${equipment.name}" is serialized; quantity must be 1.`,
            )
          }

          if (
            equipment.trackingType === 'quantity' &&
            item.quantity > equipment.totalQuantity
          ) {
            throw new Error(
              `Requested quantity (${item.quantity}) exceeds total stock (${equipment.totalQuantity}) for "${equipment.name}".`,
            )
          }

          if (equipment.requiresApproval) {
            requiresApproval = true
            if (approverId === null && equipment.approverId) {
              approverId = equipment.approverId
            }
          }
        }
      }

      // ── Conflict detection if dates or items changed ───────────────────────
      const datesChanged = startDate !== undefined || endDate !== undefined
      const itemsChanged = items !== undefined

      if (datesChanged || itemsChanged) {
        const conflictResult = await detectConflictsInTransaction(
          tx,
          adminDb,
          companyId,
          effectiveItems,
          effectiveStartDate,
          effectiveEndDate,
          bookingId,
        )

        if (conflictResult.hasConflict) {
          const names = conflictResult.conflicts.map((c) => c.equipmentName).join(', ')
          throw new Error(`Booking conflict detected for: ${names}.`)
        }
      }

      // ── Build update payload ───────────────────────────────────────────────
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updateData: Record<string, any> = {
        updatedAt: FieldValue.serverTimestamp(),
      }

      if (projectName !== undefined) updateData.projectName = projectName
      if (notes !== undefined) updateData.notes = notes
      if (startDate !== undefined) updateData.startDate = startDate
      if (endDate !== undefined) updateData.endDate = endDate
      if (items !== undefined) {
        updateData.items = items
        updateData.equipmentIds = extractEquipmentIds(items)
        updateData.unitIds = items.flatMap((i) => (i.unitId ? [i.unitId] : []))
        updateData.requiresApproval = requiresApproval
        updateData.approverId = approverId
      }

      if (datesChanged || itemsChanged) {
        if (requiresApproval) {
          updateData.status = 'pending'
          updateData.approvalStatus = 'pending'
          updateData.rejectionReason = null
        } else {
          updateData.status = 'confirmed'
          updateData.approvalStatus = 'none'
          updateData.rejectionReason = null
        }
      }

      tx.update(bookingRef, updateData)
    })

    revalidatePath('/bookings')
    revalidatePath(`/bookings/${bookingId}`)
    return {}
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update booking'
    console.error('[actions/bookings] updateBooking failed', { message })
    return { error: message }
  }
}

// ── cancelBooking ────────────────────────────────────────────────────────────

export async function cancelBooking(bookingId: string): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role === 'viewer') return { error: 'Unauthorized' }

  const companyId = session.activeCompanyId

  if (!bookingId?.trim()) return { error: 'bookingId is required' }

  const uid = session.uid
  const isAdmin = session.role === 'admin'

  try {
    await adminDb.runTransaction(async (tx) => {
      const bookingRef = adminDb.doc(`companies/${companyId}/bookings/${bookingId}`)
      const bookingSnap = await tx.get(bookingRef)

      if (!bookingSnap.exists) {
        throw new Error('Booking not found.')
      }

      const booking = bookingSnap.data() as BookingDocumentInternal

      if (!isAdmin && booking.userId !== uid) {
        throw new Error('You can only cancel your own bookings.')
      }

      if (booking.status === 'cancelled') {
        throw new Error('Booking is already cancelled.')
      }
      if (booking.status === 'returned') {
        throw new Error('Cannot cancel a returned booking.')
      }
      if (booking.status === 'checked_out') {
        throw new Error('Cannot cancel a checked-out booking. Return the equipment first.')
      }

      tx.update(bookingRef, {
        status: 'cancelled',
        cancelledAt: FieldValue.serverTimestamp(),
        cancelledBy: uid,
        updatedAt: FieldValue.serverTimestamp(),
      })
    })

    revalidatePath('/bookings')
    revalidatePath(`/bookings/${bookingId}`)
    return {}
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to cancel booking'
    console.error('[actions/bookings] cancelBooking failed', { message })
    return { error: message }
  }
}

// ── approveBooking (wraps both approve and reject) ───────────────────────────

export async function approveBooking(
  bookingId: string,
  approved: boolean,
  rejectionReason?: string,
): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role === 'viewer') return { error: 'Unauthorized' }

  const companyId = session.activeCompanyId

  if (!bookingId?.trim()) return { error: 'bookingId is required' }

  // Optional reason validation (reject path only).
  let validatedReason: string | null = null
  if (!approved && rejectionReason !== undefined && rejectionReason !== null) {
    if (typeof rejectionReason !== 'string') return { error: 'reason must be a string.' }
    if (rejectionReason.length > 500) return { error: 'reason must be 500 characters or fewer.' }
    validatedReason = rejectionReason.trim() || null
  }

  const uid = session.uid
  const isAdmin = session.role === 'admin'

  try {
    await adminDb.runTransaction(async (tx) => {
      const bookingRef = adminDb.doc(`companies/${companyId}/bookings/${bookingId}`)
      const bookingSnap = await tx.get(bookingRef)

      if (!bookingSnap.exists) {
        throw new Error('Booking not found.')
      }

      const booking = bookingSnap.data() as BookingDocumentInternal

      // ── State check ──────────────────────────────────────────────────────
      if (booking.status !== 'pending' || booking.approvalStatus !== 'pending') {
        throw new Error('Booking is not awaiting approval.')
      }

      // ── Approver check ────────────────────────────────────────────────────
      const isDesignatedApprover = booking.approverId !== null && booking.approverId === uid

      if (!isAdmin && !isDesignatedApprover) {
        throw new Error(
          approved
            ? 'Only the designated approver or an admin can approve this booking.'
            : 'Only the designated approver or an admin can reject this booking.',
        )
      }

      if (approved) {
        // Re-run conflict detection before confirming — availability may have
        // changed since the booking was originally created.
        const conflictResult = await detectConflictsInTransaction(
          tx,
          adminDb,
          companyId,
          booking.items,
          booking.startDate,
          booking.endDate,
          bookingId,
        )

        if (conflictResult.hasConflict) {
          const names = conflictResult.conflicts.map((c) => c.equipmentName).join(', ')
          throw new Error(
            `Cannot approve: conflict detected for ${names}. Resolve conflicts before approving.`,
          )
        }

        tx.update(bookingRef, {
          status: 'confirmed',
          approvalStatus: 'approved',
          updatedAt: FieldValue.serverTimestamp(),
        })
      } else {
        // status stays 'pending'; only approvalStatus changes.
        tx.update(bookingRef, {
          approvalStatus: 'rejected',
          rejectionReason: validatedReason,
          updatedAt: FieldValue.serverTimestamp(),
        })
      }
    })

    revalidatePath('/bookings')
    revalidatePath(`/bookings/${bookingId}`)
    return {}
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update approval'
    console.error('[actions/bookings] approveBooking failed', { message })
    return { error: message }
  }
}

// ── checkConflict (read-only pre-check) ─────────────────────────────────────

export async function checkConflict(
  companyId: string,
  startDate: string,
  endDate: string,
  items: BookingItem[],
  excludeBookingId?: string,
): Promise<ConflictResult> {
  const session = await getVerifiedSession()

  // Ignore caller-supplied companyId if it doesn't match the session.
  if (companyId !== session.activeCompanyId) {
    return { hasConflict: false, conflicts: [] }
  }

  let validatedItems: BookingItem[]
  let validatedStart: string
  let validatedEnd: string

  try {
    validatedItems = validateItems(items)
    validatedStart = validateDateString(startDate, 'startDate')
    validatedEnd = validateDateString(endDate, 'endDate')
  } catch {
    // Invalid input — return no conflicts; authoritative check runs on submit.
    return { hasConflict: false, conflicts: [] }
  }

  if (validatedEnd < validatedStart) {
    return { hasConflict: false, conflicts: [] }
  }

  try {
    const result = await detectConflictsReadOnly(
      adminDb,
      session.activeCompanyId,
      validatedItems,
      validatedStart,
      validatedEnd,
      excludeBookingId,
    )

    // Map internal ConflictDetail to the exported ConflictItem shape.
    return {
      hasConflict: result.hasConflict,
      conflicts: result.conflicts.map((c) => ({
        equipmentId: c.equipmentId,
        reason: c.reason,
        requested: c.requested,
        available: c.available,
      })),
    }
  } catch (err) {
    console.error('[actions/bookings] checkConflict failed', {
      message: err instanceof Error ? err.message : String(err),
    })
    // On failure return no conflicts — the authoritative check is on submit.
    return { hasConflict: false, conflicts: [] }
  }
}
