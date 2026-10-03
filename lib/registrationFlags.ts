import 'server-only'

import { cache } from 'react'
import { adminDb } from '@/lib/firebase-admin'

/**
 * Registration kill switches, stored in the single document
 * `system/registration` (operator System tab, issue "registration kill
 * switches"). Written only by `setRegistrationFlag`
 * (app/operator/(protected)/system/actions.ts); firestore.rules denies every
 * client access to `system/**`.
 */
export const REGISTRATION_DOC_PATH = 'system/registration'

export interface RegistrationFlags {
  accountsBlocked: boolean
  /** ISO timestamp of when accounts were blocked, or null while open. */
  accountsBlockedSince: string | null
  companiesBlocked: boolean
  companiesBlockedSince: string | null
}

function toIso(value: unknown): string | null {
  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

/**
 * Reads both switches. Fail-open on a MISSING document: both switches are
 * open until an operator first flips one. A read ERROR is not swallowed — it
 * propagates, so setupNewCompany fails loudly instead of silently treating an
 * unreadable flag as "open".
 *
 * Wrapped in React `cache()` so the several Server Components / actions that
 * ask during one request share a single read.
 */
export const getRegistrationFlags = cache(async (): Promise<RegistrationFlags> => {
  const snap = await adminDb.doc(REGISTRATION_DOC_PATH).get()
  const data = snap.exists ? snap.data() : undefined
  const accountsBlocked = data?.accountsBlocked === true
  const companiesBlocked = data?.companiesBlocked === true
  return {
    accountsBlocked,
    accountsBlockedSince: accountsBlocked ? toIso(data?.accountsBlockedSince) : null,
    companiesBlocked,
    companiesBlockedSince: companiesBlocked ? toIso(data?.companiesBlockedSince) : null,
  }
})
