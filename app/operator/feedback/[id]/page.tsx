import { notFound } from 'next/navigation'
import { getOperatorSession } from '@/lib/operator-dal'
import { adminDb, adminAuth } from '@/lib/firebase-admin'
import FeedbackDetailView from './FeedbackDetailView'
import type { OperatorFeedback, FeedbackNote } from '@/types/operator'

export default async function FeedbackDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await getOperatorSession()
  const { id } = await params

  const [docSnap, notesSnap] = await Promise.all([
    adminDb.doc(`operatorFeedback/${id}`).get(),
    adminDb.collection(`operatorFeedback/${id}/notes`).orderBy('createdAt', 'asc').get(),
  ])

  if (!docSnap.exists) notFound()

  const d = docSnap.data()!

  // Try to fetch email from Firebase Auth if submittedBy uid exists
  let userEmail = ''
  if (d.submittedBy) {
    try {
      const userRecord = await adminAuth.getUser(d.submittedBy)
      userEmail = userRecord.email ?? ''
    } catch {
      // user may have been deleted — not fatal
    }
  }

  const item: OperatorFeedback = {
    id: docSnap.id,
    type: d.type,
    title: d.title,
    description: d.description ?? '',
    submittedAt: d.submittedAt?.toDate?.()?.toISOString() ?? '',
    submittedBy: d.submittedBy ?? '',
    userEmail,
    companyId: d.companyId ?? '',
    companyName: d.companyName ?? '',
    userName: d.userName ?? '',
    status: d.status,
    priority: d.priority,
  }

  const notes: FeedbackNote[] = notesSnap.docs.map((n) => ({
    id: n.id,
    text: n.data().text,
    createdAt: n.data().createdAt?.toDate?.()?.toISOString() ?? '',
    createdBy: n.data().createdBy ?? '',
  }))

  return <FeedbackDetailView item={item} notes={notes} />
}
