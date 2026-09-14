import 'server-only'

import { adminDb } from '@/lib/firebase-admin'
import type { CompanyDeletionCancelToken, CompanyDeletionRecord } from '@/types'

/**
 * Every way a cancel link can turn out, as ONE closed union, so the page and
 * the action can't disagree about which situations exist.
 *
 *   - `valid`            — the deletion is still cancellable and this token
 *                          is the way to do it. The only state that renders a
 *                          button.
 *   - `unknown`          — no such token (or no ledger behind it). Covers a
 *                          mistyped URL and a token whose ledger row was
 *                          removed by the retention job years later.
 *   - `used`             — the token has already been spent. Tokens are
 *                          one-time; a second click is not a second cancel.
 *   - `expired`          — the link outlived the window it belonged to.
 *   - `already_canceled` — somebody already stopped this deletion (another
 *                          admin in the product, or this same link from a
 *                          different mailbox). Distinct from `used` on
 *                          purpose: the visitor's *goal* is met here, and
 *                          telling them "this link is used up" would read as
 *                          a failure when in fact nothing is going to be
 *                          deleted.
 *   - `company_gone`     — the deletion already ran. There is nothing left to
 *                          cancel, and this is the one outcome where the
 *                          honest answer is bad news.
 *   - `too_late`         — the purge has claimed the request (`executing`) or
 *                          given up on it (`failed`). The company may still
 *                          exist for now, but this link cannot stop what has
 *                          started; support has to.
 */
export type CancelTokenState =
  | 'valid'
  | 'unknown'
  | 'used'
  | 'expired'
  | 'already_canceled'
  | 'company_gone'
  | 'too_late'

export interface CancelTokenLookup {
  state: CancelTokenState
  /** Present whenever it could be read — the company name is safe to show to whoever holds the token. */
  companyName?: string
  /** ISO string; present for `valid` and `already_canceled`. */
  scheduledFor?: string
  /** Who asked for the deletion; present for `valid`. */
  requestedByName?: string
}

function toIso(value: unknown): string | undefined {
  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString()
  }
  return typeof value === 'string' ? value : undefined
}

function toMillis(value: unknown): number | undefined {
  const iso = toIso(value)
  if (!iso) return undefined
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * Read-only resolution of a cancel token, for RENDERING the cancel page.
 *
 * This is not the guard. `cancelCompanyDeletionByToken`
 * (actions/companyDeletion.ts) repeats every check below inside a
 * transaction, and that one is authoritative — the same split
 * `deleteAccount` uses between its read-only pre-flight and its per-company
 * commit loop, for the same reason: a page render cannot be atomic with a
 * write that happens after the visitor decides to click.
 *
 * Nothing here writes, and in particular nothing here spends the token. A
 * GET of this URL — by the visitor, by their mail client's link prefetcher,
 * by a corporate link scanner — must leave the world exactly as it found it.
 * That is a product requirement, not an implementation detail: the design
 * brief's whole argument for why a cancel link may be mailed at all is that
 * it can only ever *stop* something. A robot that cancels a deletion is as
 * wrong as a robot that executes one.
 */
export async function lookupCancelToken(token: string): Promise<CancelTokenLookup> {
  if (!token || typeof token !== 'string') return { state: 'unknown' }

  const tokenSnap = await adminDb.doc(`companyDeletionCancelTokens/${token}`).get()
  if (!tokenSnap.exists) return { state: 'unknown' }

  const tokenDoc = tokenSnap.data() as CompanyDeletionCancelToken
  const ledgerSnap = await adminDb.doc(`companyDeletions/${tokenDoc.requestId}`).get()
  if (!ledgerSnap.exists) return { state: 'unknown' }

  const ledger = ledgerSnap.data() as CompanyDeletionRecord
  const companyName = ledger.companyName ?? ''
  const scheduledFor = toIso(ledger.scheduledFor)

  // Ledger state is read BEFORE `usedAt` and before the expiry: a visitor
  // whose deletion is already stopped should be told that, not handed a
  // message about the link. See `already_canceled` in the union above.
  if (ledger.state === 'canceled') return { state: 'already_canceled', companyName, scheduledFor }
  if (ledger.state === 'completed') return { state: 'company_gone', companyName }

  if (tokenDoc.usedAt) return { state: 'used', companyName }

  const expiresAt = toMillis(tokenDoc.expiresAt)
  if (expiresAt !== undefined && expiresAt < Date.now()) return { state: 'expired', companyName }

  if (ledger.state !== 'requested') return { state: 'too_late', companyName }

  // The company document is the last thing checked, not the first: a
  // missing company with a ledger still in `requested` means the purge got
  // far enough to delete the company document but not far enough to close
  // the ledger. There is nothing left to cancel either way.
  const companySnap = await adminDb.doc(`companies/${ledger.companyId}`).get()
  if (!companySnap.exists) return { state: 'company_gone', companyName }

  return {
    state: 'valid',
    companyName: (companySnap.data()?.name as string | undefined) ?? companyName,
    scheduledFor,
    requestedByName: ledger.requestedByName ?? '',
  }
}
