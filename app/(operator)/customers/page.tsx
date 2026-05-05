import { getOperatorSession } from '@/lib/operator-dal'
import { adminDb } from '@/lib/firebase-admin'
import CustomersListView from './CustomersListView'
import type { CompanyRow } from '@/types/operator'

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  await getOperatorSession()
  const { q } = await searchParams

  const snapshot = await adminDb
    .collection('companies')
    .orderBy('createdAt', 'desc')
    .get()

  const rows: CompanyRow[] = await Promise.all(
    snapshot.docs.map(async (doc) => {
      const data = doc.data()
      const membersCount = await adminDb
        .collection(`companies/${doc.id}/members`)
        .count()
        .get()
      return {
        id: doc.id,
        name: data.name ?? '',
        createdAt: data.createdAt?.toDate?.()?.toISOString() ?? '',
        stripeCustomerId: data.stripeCustomerId ?? '',
        subscriptionStatus: data.subscription?.status ?? 'unknown',
        subscriptionPlan: data.subscription?.plan ?? '',
        currentPeriodEnd: data.subscription?.currentPeriodEnd?.toDate?.()?.toISOString()
          ?? data.subscription?.currentPeriodEnd ?? '',
        cancelAtPeriodEnd: data.subscription?.cancelAtPeriodEnd ?? false,
        hadTrial: data.hadTrial ?? false,
        memberCount: membersCount.data().count,
      }
    })
  )

  const filtered = q
    ? rows.filter((r) => r.name.toLowerCase().includes(q.toLowerCase()))
    : rows

  return <CustomersListView rows={filtered} query={q ?? ''} />
}
