import { redirect } from 'next/navigation'
import { getVerifiedSession } from '@/lib/dal'

export default async function PaymentSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>
}) {
  await getVerifiedSession()
  await searchParams
  redirect('/bookings')
}
