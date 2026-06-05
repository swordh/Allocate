'use server'
import { getOperatorSession } from '@/lib/operator-dal'
import { adminDb } from '@/lib/firebase-admin'
import { revalidatePath } from 'next/cache'
import { FieldValue } from 'firebase-admin/firestore'
import type { FeedbackStatus, FeedbackPriority } from '@/types/operator'

function rethrowRedirect(err: unknown) {
  const digest = (err as { digest?: string }).digest ?? ''
  const msg = err instanceof Error ? err.message : ''
  if (digest.startsWith('NEXT_REDIRECT') || msg.startsWith('REDIRECT:')) throw err
}

export async function updateFeedbackStatus(
  id: string, status: FeedbackStatus
): Promise<{ error?: string }> {
  try {
    await getOperatorSession()
    await adminDb.doc(`operatorFeedback/${id}`).update({ status })
    revalidatePath(`/operator/feedback/${id}`)
    revalidatePath('/operator/feedback')
    return {}
  } catch (err) {
    rethrowRedirect(err)
    return { error: 'Failed to update status' }
  }
}

export async function updateFeedbackPriority(
  id: string, priority: FeedbackPriority
): Promise<{ error?: string }> {
  try {
    await getOperatorSession()
    await adminDb.doc(`operatorFeedback/${id}`).update({ priority })
    revalidatePath(`/operator/feedback/${id}`)
    revalidatePath('/operator/feedback')
    return {}
  } catch (err) {
    rethrowRedirect(err)
    return { error: 'Failed to update priority' }
  }
}

export async function addFeedbackNote(
  id: string, text: string
): Promise<{ error?: string }> {
  try {
    const session = await getOperatorSession()
    await adminDb.collection(`operatorFeedback/${id}/notes`).add({
      text: text.trim(),
      createdAt: FieldValue.serverTimestamp(),
      createdBy: session.email,
    })
    revalidatePath(`/operator/feedback/${id}`)
    return {}
  } catch (err) {
    rethrowRedirect(err)
    return { error: 'Failed to add note' }
  }
}
