'use server'

// Full implementation in Phase 6.

import { getVerifiedSession } from '@/lib/dal'

export async function updateCompanyName(_name: string): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }
  console.log('[actions/company]', { uid: session.uid, action: 'update_company_name_stub' })
  return { error: 'Not implemented — Phase 6' }
}
