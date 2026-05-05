'use server'
import { getOperatorSession } from '@/lib/operator-dal'
import { adminDb } from '@/lib/firebase-admin'
import { revalidatePath } from 'next/cache'

export async function updateOperatorNotes(
  companyId: string,
  notes: string
): Promise<{ error?: string }> {
  try {
    await getOperatorSession()
    await adminDb.doc(`companies/${companyId}`).update({ opsNotes: notes })
    revalidatePath(`/operator/customers/${companyId}`)
    return {}
  } catch (err) {
    const digest = (err as { digest?: string }).digest ?? ''
    const msg = err instanceof Error ? err.message : ''
    if (digest.startsWith('NEXT_REDIRECT') || msg.startsWith('REDIRECT:')) throw err
    return { error: 'Failed to save notes' }
  }
}
