'use server'

import { getVerifiedSession } from '@/lib/dal'
import { adminDb } from '@/lib/firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import type { FeedbackType, FeedbackStatus, FeedbackPriority } from '@/types/operator'

export type SubmitFeedbackResult = { ticketId: string } | { error: string }

export async function submitFeedback(data: {
  type: FeedbackType
  title: string
  description: string
}): Promise<SubmitFeedbackResult> {
  try {
    const session = await getVerifiedSession()
    const { uid, activeCompanyId } = session

    // Validate
    if (!data.title.trim() || data.title.trim().length > 200) return { error: 'Invalid title' }
    if (!data.description.trim() || data.description.trim().length > 2000) return { error: 'Invalid description' }

    // Fetch user name + company name in parallel
    const [userSnap, companySnap] = await Promise.all([
      adminDb.doc(`users/${uid}`).get(),
      adminDb.doc(`companies/${activeCompanyId}`).get(),
    ])
    const userName = (userSnap.data()?.name as string) ?? session.email
    const companyName = (companySnap.data()?.name as string) ?? activeCompanyId

    // Generate human-readable ticket ID
    const prefix = data.type === 'bug_report' ? 'BUG' : data.type === 'feature_request' ? 'FEA' : 'SUP'
    const ticketId = `${prefix}-${String(Math.floor(Math.random() * 9000) + 1000)}`

    await adminDb.collection('operatorFeedback').doc(ticketId).set({
      type: data.type,
      title: data.title.trim(),
      description: data.description.trim(),
      submittedAt: FieldValue.serverTimestamp(),
      submittedBy: uid,
      companyId: activeCompanyId,
      companyName,
      userName,
      status: 'open' as FeedbackStatus,
      priority: 'medium' as FeedbackPriority,
    })

    return { ticketId }
  } catch (err) {
    const digest = (err as { digest?: string }).digest ?? ''
    const msg = err instanceof Error ? err.message : ''
    if (digest.startsWith('NEXT_REDIRECT') || msg.startsWith('REDIRECT:')) throw err
    console.error('[submitFeedback] error', err)
    return { error: 'Failed to submit. Please try again.' }
  }
}
