'use server'

// Full implementation in Phase 4.

import { getVerifiedSession } from '@/lib/dal'

export async function createCheckoutSession(
  _priceId: string,
): Promise<{ url: string } | { error: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }
  console.log('[actions/subscription]', { uid: session.uid, action: 'create_checkout_session_stub' })
  return { error: 'Not implemented — Phase 4' }
}

export async function createPortalSession(): Promise<{ url: string } | { error: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }
  console.log('[actions/subscription]', { uid: session.uid, action: 'create_portal_session_stub' })
  return { error: 'Not implemented — Phase 4' }
}
