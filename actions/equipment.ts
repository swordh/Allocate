'use server'

import { getVerifiedSession } from '@/lib/dal'
import { auth } from '@/lib/firebase'
import { httpsCallable, getFunctions, connectFunctionsEmulator } from 'firebase/functions'
import { revalidatePath } from 'next/cache'

// ---------------------------------------------------------------------------
// Firebase Callable Functions helper
// ---------------------------------------------------------------------------
// We call Cloud Functions from Server Actions using the client SDK.
// The functions run server-side (Cloud Functions), so actual business logic
// and limit enforcement live there — not here.
// ---------------------------------------------------------------------------

function getFunctionsInstance() {
  const functions = getFunctions(auth.app, 'us-central1')
  if (process.env.NODE_ENV === 'development' && process.env.FUNCTIONS_EMULATOR === 'true') {
    connectFunctionsEmulator(functions, 'localhost', 5001)
  }
  return functions
}

// ---------------------------------------------------------------------------
// createEquipment
// ---------------------------------------------------------------------------

interface CreateEquipmentPayload {
  name: string
  category: string
  trackingType: 'individual' | 'quantity'
  totalQuantity: number
  serialNumber: string | null
  status: string
  requiresApproval: boolean
  approverId: string | null
}

interface CallableFunctionResult {
  success: boolean
  data?: { id: string }
  error?: string
}

export async function createEquipment(
  formData: FormData,
): Promise<{ id: string } | { error: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  const name = (formData.get('name') as string | null)?.trim() ?? ''
  if (!name) return { error: 'Name is required' }
  if (name.length > 100) return { error: 'Name must be 100 characters or fewer' }

  const category = (formData.get('category') as string | null)?.trim() ?? ''
  const trackingType = (formData.get('trackingType') as string | null) === 'quantity' ? 'quantity' : 'individual'
  const totalQuantity = trackingType === 'quantity'
    ? parseInt(formData.get('totalQuantity') as string ?? '1', 10) || 1
    : 1
  const serialNumberRaw = formData.get('serialNumber') as string | null
  const serialNumber = trackingType === 'individual' ? (serialNumberRaw?.trim() || null) : null
  const status = (formData.get('status') as string | null) ?? 'available'
  const requiresApproval = formData.get('requiresApproval') === 'true'
  const approverIdRaw = formData.get('approverId') as string | null
  const approverId = approverIdRaw?.trim() || null

  const payload: CreateEquipmentPayload = {
    name,
    category,
    trackingType,
    totalQuantity,
    serialNumber,
    status,
    requiresApproval,
    approverId,
  }

  try {
    const functions = getFunctionsInstance()
    const addEquipment = httpsCallable<
      { companyId: string } & CreateEquipmentPayload,
      CallableFunctionResult
    >(functions, 'addEquipment')

    const result = await addEquipment({ companyId: session.activeCompanyId, ...payload })

    if (!result.data.success || !result.data.data?.id) {
      return { error: result.data.error ?? 'Failed to create equipment' }
    }

    revalidatePath('/equipment')
    revalidatePath('/settings/equipment')

    return { id: result.data.data.id }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create equipment'
    const code = err instanceof Error ? (err.message.split('/').pop() ?? 'unknown') : 'unknown'
    console.error('[actions/equipment] createEquipment failed', { code })
    return { error: message }
  }
}

// ---------------------------------------------------------------------------
// updateEquipment
// ---------------------------------------------------------------------------

interface UpdateEquipmentPayload {
  name?: string
  category?: string
  // trackingType intentionally omitted — immutable after creation
  totalQuantity?: number
  serialNumber?: string | null
  status?: string
  requiresApproval?: boolean
  approverId?: string | null
  // active intentionally omitted — deactivation routes through deactivateEquipment only
}

export async function updateEquipment(
  equipmentId: string,
  formData: FormData,
): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  const name = (formData.get('name') as string | null)?.trim()
  if (name !== undefined && name !== null && name.length > 100) {
    return { error: 'Name must be 100 characters or fewer' }
  }
  if (name !== undefined && name !== null && name.length === 0) {
    return { error: 'Name cannot be empty' }
  }

  const payload: UpdateEquipmentPayload = {}
  if (name) payload.name = name

  const category = (formData.get('category') as string | null)?.trim()
  if (category) payload.category = category

  const totalQuantityRaw = formData.get('totalQuantity')
  if (totalQuantityRaw !== null) {
    payload.totalQuantity = parseInt(totalQuantityRaw as string, 10) || 1
  }

  const serialNumberRaw = formData.get('serialNumber')
  if (serialNumberRaw !== null) {
    payload.serialNumber = (serialNumberRaw as string).trim() || null
  }

  const status = formData.get('status') as string | null
  if (status) payload.status = status

  const requiresApprovalRaw = formData.get('requiresApproval')
  if (requiresApprovalRaw !== null) {
    payload.requiresApproval = requiresApprovalRaw === 'true'
  }

  const approverIdRaw = formData.get('approverId') as string | null
  if (approverIdRaw !== null) {
    payload.approverId = approverIdRaw.trim() || null
  }

  try {
    const functions = getFunctionsInstance()
    const updateEquipmentFn = httpsCallable<
      { companyId: string; equipmentId: string } & UpdateEquipmentPayload,
      CallableFunctionResult
    >(functions, 'updateEquipment')

    const result = await updateEquipmentFn({
      companyId: session.activeCompanyId,
      equipmentId,
      ...payload,
    })

    if (!result.data.success) {
      return { error: result.data.error ?? 'Failed to update equipment' }
    }

    revalidatePath('/equipment')
    revalidatePath('/settings/equipment')

    return {}
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update equipment'
    const code = err instanceof Error ? (err.message.split('/').pop() ?? 'unknown') : 'unknown'
    console.error('[actions/equipment] updateEquipment failed', { code })
    return { error: message }
  }
}

// ---------------------------------------------------------------------------
// deactivateEquipment  (soft delete — sets active: false)
// ---------------------------------------------------------------------------

export async function deactivateEquipment(equipmentId: string): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  try {
    const functions = getFunctionsInstance()
    const deactivateEquipmentFn = httpsCallable<
      { companyId: string; equipmentId: string },
      CallableFunctionResult
    >(functions, 'deactivateEquipment')

    const result = await deactivateEquipmentFn({
      companyId: session.activeCompanyId,
      equipmentId,
    })

    if (!result.data.success) {
      return { error: result.data.error ?? 'Failed to deactivate equipment' }
    }

    revalidatePath('/equipment')
    revalidatePath('/settings/equipment')

    return {}
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to deactivate equipment'
    const code = err instanceof Error ? (err.message.split('/').pop() ?? 'unknown') : 'unknown'
    console.error('[actions/equipment] deactivateEquipment failed', { code })
    return { error: message }
  }
}
