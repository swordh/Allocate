'use server'

import { getVerifiedSession } from '@/lib/dal'
import { auth } from '@/lib/firebase'
import { httpsCallable, getFunctions, connectFunctionsEmulator } from 'firebase/functions'
import { revalidatePath } from 'next/cache'
import type { BookingItem } from '@/types'

// ---------------------------------------------------------------------------
// Firebase Callable Functions helper
// ---------------------------------------------------------------------------

function getFunctionsInstance() {
  const functions = getFunctions(auth.app, 'europe-west1')
  if (process.env.NODE_ENV === 'development' && process.env.FUNCTIONS_EMULATOR === 'true') {
    connectFunctionsEmulator(functions, 'localhost', 5001)
  }
  return functions
}

interface CallableResult {
  success: boolean
  bookingId?: string
  error?: string
}

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

// ---------------------------------------------------------------------------
// createBooking
// ---------------------------------------------------------------------------

export async function createBooking(
  formData: FormData,
): Promise<{ bookingId: string } | { error: string }> {
  const session = await getVerifiedSession()
  if (session.role === 'viewer') return { error: 'Unauthorized' }

  const projectName = (formData.get('projectName') as string | null)?.trim() ?? ''
  if (!projectName) return { error: 'Project name is required' }
  if (projectName.length > 200) return { error: 'Project name must be 200 characters or fewer' }

  const startDate = (formData.get('startDate') as string | null)?.trim() ?? ''
  if (!startDate) return { error: 'Start date is required' }

  const endDate = (formData.get('endDate') as string | null)?.trim() ?? ''
  if (!endDate) return { error: 'End date is required' }

  if (endDate < startDate) return { error: 'End date must be on or after start date' }

  const notes = (formData.get('notes') as string | null)?.trim() ?? ''
  if (notes.length > 2000) return { error: 'Notes must be 2000 characters or fewer' }

  // Items are encoded as JSON in a single "items" field.
  const itemsRaw = formData.get('items') as string | null
  let items: BookingItem[] = []
  try {
    items = itemsRaw ? (JSON.parse(itemsRaw) as BookingItem[]) : []
  } catch {
    return { error: 'Invalid equipment selection' }
  }

  if (items.length === 0) return { error: 'At least one equipment item is required' }
  if (items.length > 50) return { error: 'Maximum 50 equipment items per booking' }

  try {
    const functions = getFunctionsInstance()
    const fn = httpsCallable<
      {
        companyId: string
        projectName: string
        startDate: string
        endDate: string
        notes: string
        items: BookingItem[]
      },
      CallableResult
    >(functions, 'createBooking')

    const result = await fn({
      companyId: session.activeCompanyId,
      projectName,
      startDate,
      endDate,
      notes,
      items,
    })

    if (!result.data.success || !result.data.bookingId) {
      return { error: result.data.error ?? 'Failed to create booking' }
    }

    revalidatePath('/bookings')
    return { bookingId: result.data.bookingId }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create booking'
    console.error('[actions/bookings] createBooking failed', { message })
    return { error: message }
  }
}

// ---------------------------------------------------------------------------
// updateBooking
// ---------------------------------------------------------------------------

export async function updateBooking(
  bookingId: string,
  formData: FormData,
): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role === 'viewer') return { error: 'Unauthorized' }

  const payload: Record<string, unknown> = {
    companyId: session.activeCompanyId,
    bookingId,
  }

  const projectName = (formData.get('projectName') as string | null)?.trim()
  if (projectName !== null && projectName !== undefined) {
    if (projectName.length === 0) return { error: 'Project name is required' }
    if (projectName.length > 200) return { error: 'Project name must be 200 characters or fewer' }
    payload.projectName = projectName
  }

  const startDate = (formData.get('startDate') as string | null)?.trim()
  if (startDate) payload.startDate = startDate

  const endDate = (formData.get('endDate') as string | null)?.trim()
  if (endDate) payload.endDate = endDate

  if (startDate && endDate && endDate < startDate) {
    return { error: 'End date must be on or after start date' }
  }

  const notes = (formData.get('notes') as string | null)?.trim()
  if (notes !== null && notes !== undefined) {
    if (notes.length > 2000) return { error: 'Notes must be 2000 characters or fewer' }
    payload.notes = notes
  }

  const itemsRaw = formData.get('items') as string | null
  if (itemsRaw) {
    try {
      const items = JSON.parse(itemsRaw) as BookingItem[]
      if (items.length === 0) return { error: 'At least one equipment item is required' }
      if (items.length > 50) return { error: 'Maximum 50 equipment items per booking' }
      payload.items = items
    } catch {
      return { error: 'Invalid equipment selection' }
    }
  }

  try {
    const functions = getFunctionsInstance()
    const fn = httpsCallable<Record<string, unknown>, CallableResult>(functions, 'updateBooking')
    const result = await fn(payload)

    if (!result.data.success) {
      return { error: result.data.error ?? 'Failed to update booking' }
    }

    revalidatePath('/bookings')
    revalidatePath(`/bookings/${bookingId}`)
    return {}
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update booking'
    console.error('[actions/bookings] updateBooking failed', { message })
    return { error: message }
  }
}

// ---------------------------------------------------------------------------
// cancelBooking
// ---------------------------------------------------------------------------

export async function cancelBooking(
  bookingId: string,
): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role === 'viewer') return { error: 'Unauthorized' }

  try {
    const functions = getFunctionsInstance()
    const fn = httpsCallable<
      { companyId: string; bookingId: string },
      CallableResult
    >(functions, 'cancelBooking')

    const result = await fn({
      companyId: session.activeCompanyId,
      bookingId,
    })

    if (!result.data.success) {
      return { error: result.data.error ?? 'Failed to cancel booking' }
    }

    revalidatePath('/bookings')
    revalidatePath(`/bookings/${bookingId}`)
    return {}
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to cancel booking'
    console.error('[actions/bookings] cancelBooking failed', { message })
    return { error: message }
  }
}

// ---------------------------------------------------------------------------
// approveBooking (wraps both approveBooking and rejectBooking Cloud Functions)
// ---------------------------------------------------------------------------

export async function approveBooking(
  bookingId: string,
  approved: boolean,
  rejectionReason?: string,
): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role === 'viewer') return { error: 'Unauthorized' }

  try {
    const functions = getFunctionsInstance()

    if (approved) {
      const fn = httpsCallable<
        { companyId: string; bookingId: string },
        CallableResult
      >(functions, 'approveBooking')

      const result = await fn({
        companyId: session.activeCompanyId,
        bookingId,
      })

      if (!result.data.success) {
        return { error: result.data.error ?? 'Failed to approve booking' }
      }
    } else {
      const fn = httpsCallable<
        { companyId: string; bookingId: string; reason?: string },
        CallableResult
      >(functions, 'rejectBooking')

      const result = await fn({
        companyId: session.activeCompanyId,
        bookingId,
        reason: rejectionReason,
      })

      if (!result.data.success) {
        return { error: result.data.error ?? 'Failed to reject booking' }
      }
    }

    revalidatePath('/bookings')
    revalidatePath(`/bookings/${bookingId}`)
    return {}
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update approval'
    console.error('[actions/bookings] approveBooking failed', { message })
    return { error: message }
  }
}

// ---------------------------------------------------------------------------
// checkConflict (read-only pre-check — not authoritative, Cloud Function is)
// ---------------------------------------------------------------------------

export async function checkConflict(
  companyId: string,
  startDate: string,
  endDate: string,
  items: BookingItem[],
  excludeBookingId?: string,
): Promise<ConflictResult> {
  const session = await getVerifiedSession()

  // Security: ignore caller-supplied companyId if it doesn't match the session.
  if (companyId !== session.activeCompanyId) {
    return { hasConflict: false, conflicts: [] }
  }

  try {
    const functions = getFunctionsInstance()
    const fn = httpsCallable<
      {
        companyId: string
        startDate: string
        endDate: string
        items: BookingItem[]
        excludeBookingId?: string
      },
      ConflictResult
    >(functions, 'checkBookingConflict')

    const result = await fn({
      companyId,
      startDate,
      endDate,
      items,
      excludeBookingId,
    })

    return result.data
  } catch (err) {
    console.error('[actions/bookings] checkConflict failed', { err })
    // On failure return no conflicts — the authoritative check is on submit.
    return { hasConflict: false, conflicts: [] }
  }
}
