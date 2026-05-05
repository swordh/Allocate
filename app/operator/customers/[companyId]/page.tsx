import { getOperatorSession } from '@/lib/operator-dal'
import { adminDb } from '@/lib/firebase-admin'
import CustomerDetailView from './CustomerDetailView'
import { notFound } from 'next/navigation'

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  await getOperatorSession()
  const { companyId } = await params
  const { tab } = await searchParams

  const [companyDoc, membersSnap, bookingsCount, equipmentCount] = await Promise.all([
    adminDb.doc(`companies/${companyId}`).get(),
    adminDb.collection(`companies/${companyId}/members`).get(),
    adminDb.collection(`companies/${companyId}/bookings`).count().get(),
    adminDb.collection(`companies/${companyId}/equipment`).count().get(),
  ])

  if (!companyDoc.exists) notFound()

  const data = companyDoc.data()!
  const lastBookingSnap = await adminDb
    .collection(`companies/${companyId}/bookings`)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get()

  const lastBookingAt = lastBookingSnap.docs[0]?.data()?.createdAt?.toDate?.()?.toISOString() ?? null

  return (
    <CustomerDetailView
      company={{
        id: companyId,
        name: data.name ?? '',
        createdAt: data.createdAt?.toDate?.()?.toISOString() ?? '',
        stripeCustomerId: data.stripeCustomerId ?? '',
        hadTrial: data.hadTrial ?? false,
        opsNotes: data.opsNotes ?? '',
        subscription: {
          status: data.subscription?.status ?? '',
          plan: data.subscription?.plan ?? '',
          currentPeriodEnd: data.subscription?.currentPeriodEnd?.toDate?.()?.toISOString()
            ?? data.subscription?.currentPeriodEnd ?? '',
          cancelAtPeriodEnd: data.subscription?.cancelAtPeriodEnd ?? false,
          trialEnd: data.subscription?.trialEnd?.toDate?.()?.toISOString()
            ?? data.subscription?.trialEnd ?? null,
          interval: data.subscription?.interval ?? null,
          limits: data.subscription?.limits ?? { equipment: 0, users: 0 },
          stripeSubscriptionId: data.subscription?.stripeSubscriptionId ?? null,
        },
      }}
      members={membersSnap.docs.map((m) => ({
        uid: m.id,
        name: m.data().name ?? '',
        email: m.data().email ?? '',
        role: m.data().role ?? '',
        joinedAt: m.data().joinedAt?.toDate?.()?.toISOString() ?? '',
      }))}
      stats={{
        bookings: bookingsCount.data().count,
        equipment: equipmentCount.data().count,
        lastBookingAt,
      }}
      activeTab={tab ?? 'overview'}
    />
  )
}
