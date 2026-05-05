'use server'
import { getOperatorSession } from '@/lib/operator-dal'
import { adminDb } from '@/lib/firebase-admin'
import { revalidatePath } from 'next/cache'
import type { FeedbackStatus, FeedbackPriority, FeedbackType } from '@/types/operator'
import { FieldValue } from 'firebase-admin/firestore'

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
    revalidatePath('/operator/feedback')
    return {}
  } catch (err) {
    rethrowRedirect(err)
    return { error: 'Failed to update priority' }
  }
}

export async function createFeedback(data: {
  type: FeedbackType
  title: string
  description: string
  companyId: string
  companyName: string
}): Promise<{ error?: string }> {
  try {
    const session = await getOperatorSession()
    await adminDb.collection('operatorFeedback').add({
      ...data,
      submittedAt: FieldValue.serverTimestamp(),
      submittedBy: session.uid,
      status: 'open' as FeedbackStatus,
      priority: 'medium' as FeedbackPriority,
    })
    revalidatePath('/operator/feedback')
    return {}
  } catch (err) {
    rethrowRedirect(err)
    return { error: 'Failed to create feedback' }
  }
}
