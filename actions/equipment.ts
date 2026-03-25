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
  const functions = getFunctions(auth.app, 'europe-west1')
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
  const status = (formData.get('status') as string | null) ?? 'available'
  const requiresApproval = formData.get('requiresApproval') === 'true'
  const approverIdRaw = formData.get('approverId') as string | null
  const approverId = approverIdRaw?.trim() || null

  const payload: CreateEquipmentPayload = {
    name,
    category,
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
    console.error('[actions/equipment] createEquipment error:', err)
    return { error: message }
  }
}

// ---------------------------------------------------------------------------
// updateEquipment
// ---------------------------------------------------------------------------

interface UpdateEquipmentPayload {
  name?: string
  category?: string
  status?: string
  requiresApproval?: boolean
  approverId?: string | null
  active?: boolean
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

  const payload: UpdateEquipmentPayload = {}
  if (name) payload.name = name

  const category = (formData.get('category') as string | null)?.trim()
  if (category) payload.category = category

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

  const activeRaw = formData.get('active')
  if (activeRaw !== null) {
    payload.active = activeRaw === 'true'
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
    console.error('[actions/equipment] updateEquipment error:', err)
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
    console.error('[actions/equipment] deactivateEquipment error:', err)
    return { error: message }
  }
}
