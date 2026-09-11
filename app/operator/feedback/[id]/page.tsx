import { notFound } from 'next/navigation'
import { getOperatorSession } from '@/lib/operator-dal'
import { adminDb, adminAuth } from '@/lib/firebase-admin'
import { iso } from '@/lib/firestore-timestamps'
import FeedbackDetailView, { type SubmitterInfo, type RelatedFeedback } from './FeedbackDetailView'
import type { OperatorFeedback, FeedbackTimelineEntry } from '@/types/operator'

// Non-essential per-item lookups (email, membership role, plan, related
// tickets) are wrapped so a transient failure degrades that one row to "—"
// instead of taking the whole page down — same discipline as
// app/operator/customers/[companyId]/page.tsx's safeRead.
async function safeRead<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise
  } catch {
    return null
  }
}

export default async function FeedbackDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await getOperatorSession()
  const { id } = await params

  const docSnap = await adminDb.doc(`operatorFeedback/${id}`).get()
  if (!docSnap.exists) notFound()

  const d = docSnap.data()!

  const item: OperatorFeedback = {
    id: docSnap.id,
    // Explicit fallback, never a falsy check — same discipline as `kind ??
    // 'note'` on the timeline. Unlike that case, 'unknown' is deliberately
    // NOT a plausible real value (see the doc comment on these types in
    // types/operator.ts): a document missing type/status/priority should
    // render as visibly corrupt, not quietly pass for a normal ticket.
    type: d.type ?? 'unknown',
    title: d.title ?? '',
    description: d.description ?? '',
    submittedAt: iso(d.submittedAt),
    submittedBy: d.submittedBy ?? '',
    userEmail: '',
    companyId: d.companyId ?? '',
    companyName: d.companyName ?? '',
    userName: d.userName ?? '',
    status: d.status ?? 'unknown',
    priority: d.priority ?? 'unknown',
  }

  // The thread is chronological ascending — newest at the bottom. This is
  // the opposite of the notes list on screens 21/22/23, which is
  // deliberate: this is a thread, not a log.
  const notesSnapPromise = adminDb
    .collection(`operatorFeedback/${id}/notes`)
    .orderBy('createdAt', 'asc')
    .get()

  const userRecordPromise = item.submittedBy ? safeRead(adminAuth.getUser(item.submittedBy)) : Promise.resolve(null)
  const memberSnapPromise = item.companyId && item.submittedBy
    ? safeRead(adminDb.doc(`companies/${item.companyId}/members/${item.submittedBy}`).get())
    : Promise.resolve(null)
  const companySnapPromise = item.companyId ? safeRead(adminDb.doc(`companies/${item.companyId}`).get()) : Promise.resolve(null)
  // "MORE FROM THIS CUSTOMER" — needs the composite index added to
  // firestore.indexes.json (companyId asc, submittedAt desc). Fetches one
  // extra so the current ticket can be excluded and still fill up to 5.
  const relatedSnapPromise = item.companyId
    ? safeRead(
        adminDb
          .collection('operatorFeedback')
          .where('companyId', '==', item.companyId)
          .orderBy('submittedAt', 'desc')
          .limit(6)
          .get(),
      )
    : Promise.resolve(null)

  const [notesSnap, userRecord, memberSnap, companySnap, relatedSnap] = await Promise.all([
    notesSnapPromise,
    userRecordPromise,
    memberSnapPromise,
    companySnapPromise,
    relatedSnapPromise,
  ])

  item.userEmail = userRecord?.email ?? ''

  const timeline: FeedbackTimelineEntry[] = notesSnap.docs.map((n) => {
    const nd = n.data()
    // Explicit fallback, never a falsy check — see FeedbackTimelineEntry's
    // doc comment in types/operator.ts: a future third `kind` must surface
    // as a bug, not silently become a note.
    const kind = (nd.kind ?? 'note') as 'note' | 'event'
    return {
      id: n.id,
      kind,
      text: nd.text ?? '',
      createdAt: iso(nd.createdAt),
      createdBy: nd.createdBy ?? '',
    } as FeedbackTimelineEntry
  })

  const companyData = companySnap?.data()
  const submitter: SubmitterInfo = {
    email: item.userEmail,
    role: memberSnap?.exists ? (memberSnap.data()?.role ?? '') : '',
    plan: companyData
      ? [companyData.subscription?.plan, companyData.subscription?.status]
          .filter(Boolean)
          .map((s: string) => s.charAt(0).toUpperCase() + s.slice(1))
          .join(' · ')
      : '',
  }

  const related: RelatedFeedback[] = relatedSnap
    ? relatedSnap.docs
        .filter((r) => r.id !== id)
        .slice(0, 5)
        .map((r) => {
          const rd = r.data()
          return {
            id: r.id,
            title: rd.title ?? '',
            type: rd.type ?? 'unknown',
            status: rd.status ?? 'unknown',
            submittedAt: iso(rd.submittedAt),
          }
        })
    : []

  return <FeedbackDetailView item={item} timeline={timeline} submitter={submitter} related={related} />
}
