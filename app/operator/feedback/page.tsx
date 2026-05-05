import { getOperatorSession } from '@/lib/operator-dal'
import { adminDb } from '@/lib/firebase-admin'
import FeedbackListView from './FeedbackListView'
import type { OperatorFeedback } from '@/types/operator'

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; status?: string }>
}) {
  await getOperatorSession()
  const { type, status } = await searchParams

  const snapshot = await adminDb
    .collection('operatorFeedback')
    .orderBy('submittedAt', 'desc')
    .get()

  let items: OperatorFeedback[] = snapshot.docs.map((doc) => {
    const d = doc.data()
    return {
      id: doc.id,
      type: d.type,
      title: d.title,
      description: d.description,
      submittedAt: d.submittedAt?.toDate?.()?.toISOString() ?? '',
      submittedBy: d.submittedBy,
      companyId: d.companyId ?? '',
      companyName: d.companyName ?? '',
      status: d.status,
      priority: d.priority,
    }
  })

  if (type && type !== 'all') items = items.filter((i) => i.type === type)
  if (status && status !== 'all') items = items.filter((i) => i.status === status)

  return <FeedbackListView items={items} activeType={type ?? 'all'} activeStatus={status ?? 'all'} />
}
