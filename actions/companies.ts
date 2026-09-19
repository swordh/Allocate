'use server'

import { getVerifiedSession } from '@/lib/dal'
import { listUserCompanies, type UserCompany } from '@/lib/queries/companies'

/**
 * Companies the current user can switch into, for the company switcher UI
 * (issue #352). Thin wrapper, same shape as `getAccountDeletionPreview`
 * (actions/account.ts) — the real work is in `listUserCompanies`.
 */
export async function getSwitchableCompanies(): Promise<UserCompany[]> {
  const session = await getVerifiedSession()
  return listUserCompanies(session.uid)
}
