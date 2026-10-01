'use server'
import { getOperatorSession, rethrowRedirect } from '@/lib/operator-dal'
import { adminDb } from '@/lib/firebase-admin'
import { revalidatePath } from 'next/cache'
import { FieldValue } from 'firebase-admin/firestore'

// Replaces the old `opsNotes` single-string field on companies/{id} — that
// field was readable by any member of the company (see firestore.rules'
// companies/{companyId} rule), so an operator's private notes about a
// customer were readable by that customer. operatorNotes is a top-level
// collection with no Firestore rule, so it is default-deny to clients —
// same pattern as operatorFeedback/{id}/notes (app/operator/feedback/actions.ts).
export async function addOperatorNote(
  companyId: string, text: string
): Promise<{ error?: string }> {
  try {
    const session = await getOperatorSession()
    const trimmed = text.trim()
    if (!trimmed) return { error: 'Note is empty' }
    await adminDb.collection('operatorNotes').add({
      companyId,
      text: trimmed,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: session.email,
    })
    revalidatePath(`/operator/customers/${companyId}`)
    revalidatePath('/operator/customers')
    return {}
  } catch (err) {
    rethrowRedirect(err)
    return { error: 'Failed to add note' }
  }
}
