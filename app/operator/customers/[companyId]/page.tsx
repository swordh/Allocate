import { getOperatorSession } from '@/lib/operator-dal'
import { adminDb } from '@/lib/firebase-admin'
import { stripe } from '@/lib/stripe'
import CustomerDetailView from './CustomerDetailView'
import { notFound } from 'next/navigation'
import { iso, isoOrNull, tsToMillis, isoToMillis, unixSecondsToMillis } from '@/lib/firestore-timestamps'
import { sortFeed, type FeedEntry } from './activity'

const DAY_MS = 24 * 60 * 60 * 1000

// Everything on this screen that isn't a direct doc-get is capped, including
// this one — its cost otherwise grows with every note ever written to this
// company, on every page view.
const NOTES_LIMIT = 50

/**
 * Only the Stripe calls used to be wrapped. A transient Firestore error on
 * any of the other reads — most concretely, an index that hasn't finished
 * propagating to an environment yet (exactly how issue #258 played out) —
 * would 500 the entire page instead of degrading one section of it. Mirrors
 * the try/catch-and-degrade the customers list page already applies to its
 * equivalent per-company reads.
 */
async function safeRead<T>(promise: Promise<T>, label: string, context: Record<string, unknown>): Promise<T | null> {
  try {
    return await promise
  } catch (err) {
    console.error('[operator/customers/detail] read_failed', { query: label, ...context, err })
    return null
  }
}

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ companyId: string }>
}) {
  await getOperatorSession()
  const { companyId } = await params

  const cutoff30d = new Date(Date.now() - 30 * DAY_MS)

  // The company doc itself is essential — nothing on this page can render
  // without it — so it stays unwrapped, same as the list page leaves its
  // main `companies` scan unwrapped. Every other read here is optional: the
  // page degrades that one section rather than disappearing.
  const [companyDoc, membersSnap, bookingsCountSnap, equipmentCountSnap, bookings30dSnap, recentBookingsSnap, notesSnap, planEventsSnap] =
    await Promise.all([
      adminDb.doc(`companies/${companyId}`).get(),
      safeRead(adminDb.collection(`companies/${companyId}/members`).get(), 'members', { companyId }),
      safeRead(adminDb.collection(`companies/${companyId}/bookings`).count().get(), 'bookingsCount', { companyId }),
      // Active only, matching both the plan limit and the list's mirrored count.
      safeRead(adminDb.collection(`companies/${companyId}/equipment`).where('active', '==', true).count().get(), 'equipmentCount', { companyId }),
      // `where('createdAt', '>=', …)` silently excludes bookings missing
      // `createdAt` (tools/backfill_company_stats.js already warns some do) —
      // this count can undercount, never overcount.
      safeRead(adminDb.collection(`companies/${companyId}/bookings`).where('createdAt', '>=', cutoff30d).count().get(), 'bookings30d', { companyId }),
      // The old page ran a separate limit(1) query just for "last booking".
      // Folded into one limit(10) query, shared with the activity feed below.
      safeRead(adminDb.collection(`companies/${companyId}/bookings`).orderBy('createdAt', 'desc').limit(10).get(), 'recentBookings', { companyId }),
      safeRead(
        adminDb.collection('operatorNotes').where('companyId', '==', companyId).orderBy('createdAt', 'desc').limit(NOTES_LIMIT).get(),
        'operatorNotes',
        { companyId },
      ),
      safeRead(adminDb.collection('companyEvents').where('companyId', '==', companyId).orderBy('at', 'desc').limit(20).get(), 'companyEvents', { companyId }),
    ])

  if (!companyDoc.exists) notFound()

  const data = companyDoc.data()!
  const companyCreatedAtMs = tsToMillis(data.createdAt)

  const teamUnavailable = membersSnap === null
  const members = membersSnap
    ? membersSnap.docs.map((m) => ({
        uid: m.id,
        name: m.data().name ?? '',
        email: m.data().email ?? '',
        role: m.data().role ?? '',
        joinedAt: m.data().joinedAt?.toDate?.()?.toISOString() ?? '',
      }))
    : []

  const bookingsTotal  = bookingsCountSnap ? bookingsCountSnap.data().count : null
  const equipmentCount = equipmentCountSnap ? equipmentCountSnap.data().count : null
  const bookings30d    = bookings30dSnap ? bookings30dSnap.data().count : null

  const bookingHistoryUnavailable = recentBookingsSnap === null
  const recentBookings = recentBookingsSnap
    ? recentBookingsSnap.docs.map((b) => ({
        id: b.id,
        projectName: b.data().projectName ?? '',
        createdAt: b.data().createdAt,
      }))
    : []
  const lastBooking = recentBookings[0] ?? null

  const notesUnavailable = notesSnap === null
  const notesCapped = notesSnap ? notesSnap.size === NOTES_LIMIT : false
  const notes = notesSnap
    ? notesSnap.docs.map((n) => ({
        id: n.id,
        text: n.data().text ?? '',
        createdAt: n.data().createdAt?.toDate?.()?.toISOString() ?? '',
        createdBy: n.data().createdBy ?? '',
      }))
    : []

  const planEventsUnavailable = planEventsSnap === null
  const planEventDocs = planEventsSnap ? planEventsSnap.docs : []

  // ---- Billing: live from Stripe per page view, per Part 2's settled
  // decision. This is an availability risk, not a cost risk — the page is a
  // Server Component, so an unhandled throw here would take the entire
  // customer detail down with it. Wrapped so a slow/erroring Stripe instead
  // degrades to a "payments unavailable" marker in the feed and a `null`
  // MRR, never a 500.
  const stripeCustomerId: string = data.stripeCustomerId ?? ''
  let paymentEntries: FeedEntry[] = []
  let paymentsUnavailable = false
  let mrr: number | null = null

  if (stripeCustomerId) {
    try {
      const [invoices, subscription] = await Promise.all([
        stripe.invoices.list({ customer: stripeCustomerId, limit: 10 }),
        data.subscription?.stripeSubscriptionId
          ? stripe.subscriptions.retrieve(data.subscription.stripeSubscriptionId)
          : Promise.resolve(null),
      ])

      paymentEntries = invoices.data.map((inv) => {
        const at = unixSecondsToMillis(inv.created)!
        const amount = ((inv.amount_paid || inv.amount_due) / 100).toLocaleString('sv-SE')
        const succeeded = inv.status === 'paid'
        return {
          kind: succeeded ? 'payment_succeeded' : 'payment_failed',
          at,
          atIso: new Date(at).toISOString(),
          text: succeeded
            ? `Payment succeeded — ${amount} ${inv.currency.toUpperCase()}`
            : `Payment ${inv.status} — ${amount} ${inv.currency.toUpperCase()}`,
        } as FeedEntry
      })

      // MRR is only meaningful while the company is actually being billed —
      // a canceled subscription still carries a price on its last item, and
      // showing that as "MRR" would claim revenue that isn't being
      // collected. Multiplied by `quantity`, since a multi-seat price line
      // isn't 1 by default. This is Stripe's LIST price: it does not read
      // discounts or coupons (checkout has `allow_promotion_codes` on, so
      // discounted customers exist) — the view labels it as such rather
      // than presenting it as the customer's real invoiced total.
      const item = subscription?.items.data[0]
      const billedStatus = data.subscription?.status === 'active' || data.subscription?.status === 'trialing'
      if (billedStatus && item?.price?.unit_amount != null) {
        const quantity = item.quantity ?? 1
        const totalAmount = item.price.unit_amount * quantity
        // `/100` assumes a two-decimal currency — true for SEK, but would
        // understate a zero-decimal currency (e.g. JPY) by 100x.
        const monthly = item.price.recurring?.interval === 'year' ? totalAmount / 12 : totalAmount
        mrr = Math.round(monthly / 100)
      }
    } catch (err) {
      console.error('[operator/customers/detail] stripe_fetch_failed', { companyId, err })
      paymentsUnavailable = true
    }
  }

  // ---- Activity feed: assembled from five sources, normalised to epoch ms.
  const feed: FeedEntry[] = []

  if (companyCreatedAtMs !== null) {
    feed.push({
      kind: 'account_created',
      at: companyCreatedAtMs,
      atIso: new Date(companyCreatedAtMs).toISOString(),
      // "Account created", not "Subscription started" — they coincide only
      // because setupNewCompany sets `trialing` at creation; that label
      // would be a lie for anyone who never checked out.
      text: 'Account created',
    })
  }

  for (const m of members) {
    const at = isoToMillis(m.joinedAt)
    if (at === null) continue
    feed.push({
      kind: 'member_joined',
      at,
      atIso: m.joinedAt,
      text: `${m.name || m.email || 'A member'} joined as ${m.role || 'member'}`,
    })
  }

  for (const b of recentBookings) {
    const at = tsToMillis(b.createdAt)
    if (at === null) continue
    feed.push({
      kind: 'booking_created',
      at,
      atIso: new Date(at).toISOString(),
      text: `Booking created — ${b.projectName || 'Untitled booking'}`,
    })
  }

  feed.push(...paymentEntries)

  for (const e of planEventDocs) {
    const d = e.data()
    const at = tsToMillis(d.at)
    if (at === null) continue
    feed.push({
      kind: d.kind === 'status_changed' ? 'status_changed' : 'plan_changed',
      at,
      atIso: new Date(at).toISOString(),
      text: d.kind === 'status_changed'
        ? `Status changed ${d.fromStatus ?? '—'} → ${d.toStatus} (plan: ${d.toPlan})`
        : `Plan changed ${d.fromPlan ?? '—'} → ${d.toPlan} (${d.fromStatus ?? '—'} → ${d.toStatus})`,
    })
  }

  const sortedFeed = sortFeed(feed)

  return (
    <CustomerDetailView
      company={{
        id: companyId,
        name: data.name ?? '',
        createdAt: iso(data.createdAt),
        stripeCustomerId,
        hadTrial: data.hadTrial ?? false,
        subscription: {
          status: data.subscription?.status ?? '',
          plan: data.subscription?.plan ?? '',
          currentPeriodEnd: isoOrNull(data.subscription?.currentPeriodEnd),
          cancelAtPeriodEnd: data.subscription?.cancelAtPeriodEnd ?? false,
          trialEnd: isoOrNull(data.subscription?.trialEnd),
          interval: data.subscription?.interval ?? null,
          // Not guaranteed present — render as unknown, never a fabricated 0.
          limits: {
            equipment: typeof data.subscription?.limits?.equipment === 'number'
              ? data.subscription.limits.equipment
              : null,
            users: typeof data.subscription?.limits?.users === 'number'
              ? data.subscription.limits.users
              : null,
          },
          stripeSubscriptionId: data.subscription?.stripeSubscriptionId ?? null,
        },
      }}
      members={members}
      stats={{
        bookingsTotal,
        bookings30d,
        equipmentCount,
        lastBooking: lastBooking
          ? {
              at: lastBooking.createdAt?.toDate?.()?.toISOString() ?? null,
              projectName: lastBooking.projectName || null,
            }
          : null,
        mrr,
      }}
      notes={notes}
      notesCapped={notesCapped}
      feed={sortedFeed}
      paymentsUnavailable={paymentsUnavailable}
      unavailable={{
        team: teamUnavailable,
        bookingHistory: bookingHistoryUnavailable,
        notes: notesUnavailable,
        planEvents: planEventsUnavailable,
      }}
    />
  )
}
